// Recurrence for scheduled tasks, plus the human phrasing the panel shows.
// Pure so the next-run arithmetic — the part that silently goes wrong across
// midnight, week boundaries, and a paused task — is testable.

export type Recurrence =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }

/** One-shot jobs and continuing local sessions cannot be represented by an Actions schedule. */
export function supportsGithubSchedule(kind: Recurrence["kind"], targets: readonly { sessionId?: string }[]) {
  return ["daily", "weekdays", "weekly"].includes(kind) && targets.length === 1 && !targets[0].sessionId
}

export type ScheduledTask = {
  id: string
  title: string
  prompt: string
  directory: string
  recurrence: Recurrence
  paused: boolean
  createdAt: string
  lastRunAt?: string
  lastStatus?: "completed" | "failed" | "canceled"
  cloud?: boolean
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// "08:00" -> {hours: 8, minutes: 0}. Invalid input yields undefined so callers
// render "Invalid schedule" instead of silently running at midnight.
export function parseTime(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return { hours, minutes }
}

export function formatTime(time: string) {
  const parsed = parseTime(time)
  if (!parsed) return time
  const suffix = parsed.hours < 12 ? "AM" : "PM"
  const hour = parsed.hours % 12 === 0 ? 12 : parsed.hours % 12
  return `${hour}:${String(parsed.minutes).padStart(2, "0")} ${suffix}`
}

export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.kind === "once") {
    const at = new Date(recurrence.at)
    if (Number.isNaN(at.getTime())) return "Invalid schedule"
    return `Once on ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
  }
  if (recurrence.kind === "daily") return `Every day at ${formatTime(recurrence.time)}`
  if (recurrence.kind === "weekdays") return `Weekdays at ${formatTime(recurrence.time)}`
  return `${WEEKDAY_NAMES[recurrence.weekday] ?? "Sunday"}s at ${formatTime(recurrence.time)}`
}

function atTime(base: Date, time: { hours: number; minutes: number }) {
  const next = new Date(base)
  next.setHours(time.hours, time.minutes, 0, 0)
  return next
}

const isWeekday = (date: Date) => date.getDay() >= 1 && date.getDay() <= 5

// The next moment this task should run, or undefined when it never will again
// (a one-shot already past). Strictly after `from`, so a task that just ran does
// not immediately re-fire.
export function nextRun(recurrence: Recurrence, from: Date): Date | undefined {
  if (recurrence.kind === "once") {
    const at = new Date(recurrence.at)
    if (Number.isNaN(at.getTime()) || at <= from) return undefined
    return at
  }

  const time = parseTime(recurrence.time)
  if (!time) return undefined

  if (recurrence.kind === "daily") {
    const today = atTime(from, time)
    return today > from ? today : atTime(new Date(from.getTime() + 86_400_000), time)
  }

  if (recurrence.kind === "weekdays") {
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = atTime(new Date(from.getTime() + offset * 86_400_000), time)
      if (candidate > from && isWeekday(candidate)) return candidate
    }
    return undefined
  }

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = atTime(new Date(from.getTime() + offset * 86_400_000), time)
    if (candidate > from && candidate.getDay() === recurrence.weekday) return candidate
  }
  return undefined
}

// "Next run in 6 days" / "Next run in 2 hours". Deliberately coarse: a live
// countdown to the minute invites the reader to trust a precision the
// scheduler does not actually guarantee.
export function describeNextRun(next: Date | undefined, now: Date): string {
  if (!next) return "No further runs"
  const ms = next.getTime() - now.getTime()
  if (ms <= 0) return "Due now"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `Next run in ${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Next run in ${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.round(hours / 24)
  return `Next run in ${days} day${days === 1 ? "" : "s"}`
}

export type TaskFilter = "all" | "active" | "paused"

export function filterTasks(tasks: readonly ScheduledTask[], filter: TaskFilter, query: string) {
  const needle = query.trim().toLowerCase()
  return tasks
    .filter((task) => (filter === "all" ? true : filter === "paused" ? task.paused : !task.paused))
    .filter((task) => (!needle ? true : `${task.title} ${task.prompt}`.toLowerCase().includes(needle)))
}

// Sorted by when they will actually next run, so what is imminent is on top.
// Paused tasks sink below active ones regardless of their nominal schedule.
export function sortByNextRun(tasks: readonly ScheduledTask[], now: Date) {
  return [...tasks].sort((a, b) => {
    if (a.paused !== b.paused) return a.paused ? 1 : -1
    const aNext = nextRun(a.recurrence, now)?.getTime() ?? Infinity
    const bNext = nextRun(b.recurrence, now)?.getTime() ?? Infinity
    return aNext - bNext
  })
}

export type Suggestion = {
  title: string
  schedule: string
  description: string
  recurrence: Recurrence
  prompt: string
}

export const SUGGESTIONS: Suggestion[] = [
  {
    title: "Morning repo brief",
    schedule: "Weekdays at 8:00 AM",
    description: "Summarise what changed overnight, open pull requests, and anything failing checks",
    recurrence: { kind: "weekdays", time: "08:00" },
    prompt:
      "Summarise what changed in this repository since yesterday: new commits, open pull requests, and any failing checks. Keep it to a short brief.",
  },
  {
    title: "Dependency check",
    schedule: "Mondays at 9:00 AM",
    description: "Look for outdated or vulnerable dependencies and report what is worth upgrading",
    recurrence: { kind: "weekly", weekday: 1, time: "09:00" },
    prompt:
      "Check this repository's dependencies for outdated or vulnerable packages. Report only upgrades worth making and why.",
  },
  {
    title: "Weekly review",
    schedule: "Fridays at 4:00 PM",
    description: "Turn the week's work into a concise status update",
    recurrence: { kind: "weekly", weekday: 5, time: "16:00" },
    prompt: "Review this week's commits and changes in the repository and write a concise status update.",
  },
]

// The recurrence the form currently describes, or undefined when the inputs
// cannot form a valid schedule (empty time, unparseable date). Returning
// undefined keeps the submit button disabled instead of creating a task that
// silently never runs.
export function buildRecurrence(input: {
  kind: Recurrence["kind"]
  at: string
  time: string
  weekday: number
}): Recurrence | undefined {
  if (input.kind === "once") {
    const at = new Date(input.at)
    if (!input.at || Number.isNaN(at.getTime())) return undefined
    return { kind: "once", at: at.toISOString() }
  }
  // parseTime is the single source of truth for a valid clock time; a bare
  // regex here would accept "25:00" and build a schedule that never fires.
  if (!parseTime(input.time)) return undefined
  if (input.kind === "daily") return { kind: "daily", time: input.time }
  if (input.kind === "weekdays") return { kind: "weekdays", time: input.time }
  return { kind: "weekly", weekday: input.weekday, time: input.time }
}

// --- Automations -----------------------------------------------------------
//
// An automation is one prompt on one schedule that fans out across several
// repositories. These shapes mirror the desktop scheduler's
// ScheduledAgentTarget / ScheduledAgentRecord structurally; the renderer cannot
// import from the main process, so they are declared here and the IPC boundary
// checks them at the call site.

export type AutomationTarget = {
  directory: string
  // Set to continue an existing session instead of opening a new one each run.
  sessionId?: string
}

export type AutomationTargetResult = AutomationTarget & {
  status: "running" | "completed" | "failed" | "canceled"
  startedAt: string
  completedAt?: string
  error?: string
}

export type AutomationRecord = {
  id: string
  title?: string
  prompt: string
  recurrence?: Recurrence
  paused?: boolean
  directory: string
  targets?: AutomationTarget[]
  runAt: string
  status: "scheduled" | "running" | "completed" | "failed" | "canceled"
  createdAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  results?: AutomationTargetResult[]
  missedRuns?: number
}

// What the scheduler will actually be asked to create. Structurally a
// CreateScheduledAgentInput: `directory` mirrors the first target so a build
// that predates multi-repo targeting still understands the record.
export type AutomationInput = {
  title: string
  prompt: string
  recurrence: Recurrence
  directory: string
  targets: AutomationTarget[]
  runAt: string
}

// One row of the "where does it run" picker. `directory` is the directory the
// run happens in, which is the session's own directory when an existing session
// was picked — a session living in a sandbox is not addressable from the
// repository worktree.
export type AutomationTargetDraft = {
  directory: string
  enabled: boolean
  sessionId: string
}

export type AutomationDraft = {
  title: string
  prompt: string
  targets: readonly AutomationTargetDraft[]
  kind: Recurrence["kind"]
  at: string
  time: string
  weekday: number
}

export function buildAutomationTargets(drafts: readonly AutomationTargetDraft[]): AutomationTarget[] {
  return drafts
    .filter((draft) => draft.enabled && draft.directory.trim() !== "")
    .map((draft) =>
      draft.sessionId ? { directory: draft.directory, sessionId: draft.sessionId } : { directory: draft.directory },
    )
}

// The input the form currently describes, or the reason it cannot be created.
// The reason is returned rather than a bare undefined so the panel can say why
// the button is disabled instead of leaving the reader to guess which of four
// fields is wrong.
export function buildAutomationInput(
  draft: AutomationDraft,
  now: Date,
): { ok: true; input: AutomationInput } | { ok: false; error: string } {
  const prompt = draft.prompt.trim()
  if (!prompt) return { ok: false, error: "Write the task this automation should run." }

  const targets = buildAutomationTargets(draft.targets)
  if (targets.length === 0) return { ok: false, error: "Choose at least one repository to run in." }

  const recurrence = buildRecurrence({ kind: draft.kind, at: draft.at, time: draft.time, weekday: draft.weekday })
  if (!recurrence) {
    return { ok: false, error: draft.kind === "once" ? "Pick a date and time." : "Pick a valid time." }
  }

  // A one-shot already in the past has no next run, so the scheduler would
  // store a record that can never fire. Refuse it at the form.
  const runAt = nextRun(recurrence, now)
  if (!runAt) return { ok: false, error: "That time has already passed. Pick a moment in the future." }

  return {
    ok: true,
    input: {
      title: draft.title.trim() || prompt.split("\n")[0]?.slice(0, 80) || "Automation",
      prompt,
      recurrence,
      directory: targets[0].directory,
      targets,
      runAt: runAt.toISOString(),
    },
  }
}

// The targets a record runs against. A record written before multi-repo
// targeting has no `targets` array and reads as the single directory it always
// was.
export function automationTargets(record: Pick<AutomationRecord, "directory" | "targets">): AutomationTarget[] {
  const listed = record.targets?.filter((target) => typeof target?.directory === "string" && target.directory !== "")
  if (listed && listed.length > 0) return listed
  return [{ directory: record.directory }]
}

// Results are index-aligned with the targets, not keyed by directory or
// session: the scheduler fills in `sessionId` on a result once it opens a
// session, so a target that asked for a new session no longer matches its own
// result by value.
export function automationTargetResults(record: Pick<AutomationRecord, "directory" | "targets" | "results">) {
  return automationTargets(record).map((target, index) => ({ target, result: record.results?.[index] }))
}

export function describeAutomationTargets(
  targets: readonly AutomationTarget[],
  name: (directory: string) => string,
): string {
  if (targets.length === 0) return "No repositories"
  if (targets.length === 1) {
    const only = targets[0]
    return `${name(only.directory)} · ${only.sessionId ? "existing session" : "new session each run"}`
  }
  const continuing = targets.filter((target) => target.sessionId).length
  if (continuing === 0) return `${targets.length} repositories · new session each run`
  if (continuing === targets.length) return `${targets.length} repositories · existing sessions`
  return `${targets.length} repositories · ${continuing} existing, ${targets.length - continuing} new`
}

// `runAt` is the scheduler's own pending slot, so it is trusted over recomputing
// the recurrence here: a run pulled forward by hand, or advanced past a window
// missed while the app was closed, sits somewhere the rule alone cannot predict.
export function describeAutomationNextRun(
  record: Pick<AutomationRecord, "runAt" | "paused" | "status" | "recurrence">,
  now: Date,
): string {
  if (record.paused) return "Paused"
  if (record.status === "running") return "Running now"
  const at = new Date(record.runAt)
  if (record.status === "scheduled") return describeNextRun(Number.isNaN(at.getTime()) ? undefined : at, now)
  if (record.recurrence && record.recurrence.kind !== "once") {
    return describeNextRun(nextRun(record.recurrence, now), now)
  }
  return "No further runs"
}

// Says out loud that a burst of occurrences was collapsed into one run. The
// wording is the desktop scheduler's describeCatchUp, kept identical so the
// window and the tray never tell the user two different stories.
export function describeMissedRuns(missedRuns: number | undefined): string | undefined {
  if (!missedRuns) return undefined
  const missed = missedRuns === 1 ? "1 earlier run was" : `${missedRuns} earlier runs were`
  return `Caught up with a single run; ${missed} missed while Vector was closed and will not be replayed.`
}

// Imminent first, paused last. Records the scheduler has already settled sink
// below the ones still waiting to fire.
export function sortAutomations(records: readonly AutomationRecord[]) {
  return [...records].sort((a, b) => {
    if (!!a.paused !== !!b.paused) return a.paused ? 1 : -1
    const pending = (record: AutomationRecord) => (record.status === "scheduled" || record.status === "running" ? 0 : 1)
    if (pending(a) !== pending(b)) return pending(a) - pending(b)
    const at = (record: AutomationRecord) => {
      const time = new Date(record.runAt).getTime()
      return Number.isNaN(time) ? Infinity : time
    }
    return at(a) - at(b)
  })
}
