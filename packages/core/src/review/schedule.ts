export type Recurrence =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }

export const UTC_SCHEDULE_NOTE =
  "GitHub uses a fixed UTC schedule. Daylight saving changes can shift the local run time by ±1 hour."

function offsetMinutes(timeZone: string, now: Date) {
  const name = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value
  if (name === "GMT" || name === "UTC") return 0
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "")
  if (!match) throw new Error("This time zone cannot be converted to a GitHub schedule.")
  return (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1)
}

const weekday = (value: number) => ((value % 7) + 7) % 7

/** Convert the chosen local wall time at setup into UTC. Actions does not track future daylight-saving changes. */
export function cronFor(recurrence: Recurrence, timeZone: string, now = new Date()) {
  if (recurrence.kind === "once") return undefined
  if (!["daily", "weekdays", "weekly"].includes(recurrence.kind)) return undefined
  const time = /^(\d{1,2}):(\d{2})$/.exec(recurrence.time.trim())
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || !Number.isFinite(now.getTime())) return undefined
  if (
    recurrence.kind === "weekly" &&
    (!Number.isInteger(recurrence.weekday) || recurrence.weekday < 0 || recurrence.weekday > 6)
  )
    return undefined
  let offset: number
  try {
    offset = offsetMinutes(timeZone, now)
  } catch {
    return undefined
  }
  const minutes = Number(time[1]) * 60 + Number(time[2]) - offset
  const shift = Math.floor(minutes / 1440)
  const clock = ((minutes % 1440) + 1440) % 1440
  const days =
    recurrence.kind === "daily"
      ? "*"
      : recurrence.kind === "weekly"
        ? String(weekday(recurrence.weekday + shift))
        : [1, 2, 3, 4, 5]
            .map((day) => weekday(day + shift))
            .sort((a, b) => a - b)
            .join(",")
  return { cron: `${clock % 60} ${Math.floor(clock / 60)} * * ${days}`, note: UTC_SCHEDULE_NOTE }
}

export function scheduleId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/.test(value))
    throw new Error("A GitHub schedule needs a stable id of at most 64 letters, numbers, underscores or hyphens.")
  return value
}

export function validCron(cron: string) {
  const fields = cron.trim().split(/\s+/)
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const
  return (
    fields.length === 5 &&
    fields.every((field, index) =>
      field.split(",").every((part) => {
        const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
        if (!match) return false
        const [low, high] = bounds[index]!
        const start = match[1] === "*" ? low : Number(match[1])
        const end = match[2] === undefined ? (match[1] === "*" ? high : start) : Number(match[2])
        return (
          start >= low &&
          start <= high &&
          end >= start &&
          end <= high &&
          !(match[1] === "*" && match[2] !== undefined) &&
          (match[3] === undefined || (Number(match[3]) > 0 && Number(match[3]) <= high - low + 1))
        )
      }),
    )
  )
}

/** Distinct schedules may share a wall time, but GitHub supplies only the cron string when a tick fires. */
export function spreadScheduleMinutes<T extends { id: string; cron: string }>(schedules: readonly T[]): T[] {
  if (schedules.length > 20 || new Set(schedules.map((entry) => scheduleId(entry.id))).size !== schedules.length)
    throw new Error("GitHub schedules need unique ids and at most 20 entries.")
  const used = new Set<string>()
  return schedules.map((entry) => {
    if (!validCron(entry.cron)) throw new Error("The GitHub schedule has invalid calendar fields.")
    let cron = entry.cron
    if (used.has(cron)) {
      const parts = cron.trim().split(/\s+/)
      if (parts.length !== 5 || !/^\d{1,2}$/.test(parts[0] ?? ""))
        throw new Error("Schedules sharing a cron need a single numeric minute so they can be spread safely.")
      const minute = Number(parts[0])
      if (minute > 59) throw new Error("The GitHub schedule minute is invalid.")
      const found = Array.from({ length: 59 }, (_, index) => (minute + index + 1) % 60)
        .map((candidate) => [candidate, ...parts.slice(1)].join(" "))
        .find((candidate) => !used.has(candidate))
      if (!found) throw new Error("No distinct GitHub schedule minute is available.")
      cron = found
    }
    used.add(cron)
    return { ...entry, cron }
  })
}
