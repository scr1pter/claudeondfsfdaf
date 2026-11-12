import { createHash } from "node:crypto"
import { z } from "zod"
import { validCron } from "@vectordevai/core/review/schedule"

export const UNKNOWN_SCHEDULE = "Nothing to do: this schedule is not configured."
const Schedule = z
  .object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$(?![\s\S])/), prompt: z.string().min(1).max(100_000) })
  .strict()

/** A schedule tick carries only its cron; the trusted generated workflow owns the prompt and stable id. */
export function lookupSchedule(env: Readonly<Record<string, string | undefined>>, payload: unknown) {
  try {
    const tick = z.object({ schedule: z.string().max(256) }).parse(payload)
    const text = env.VECTOR_SCHEDULE_PROMPTS
    if (!text || Buffer.byteLength(text) > 2_100_000) return undefined
    const entries = z.record(z.string(), Schedule).parse(JSON.parse(text))
    if (
      Object.keys(entries).length > 20 ||
      Object.keys(entries).some((cron) => !validCron(cron)) ||
      new Set(Object.values(entries).map((entry) => entry.id)).size !== Object.keys(entries).length
    )
      return undefined
    const schedule = Object.hasOwn(entries, tick.schedule) ? entries[tick.schedule] : undefined
    if (!schedule) return undefined
    return {
      ...schedule,
      cron: tick.schedule,
      thread: `schedule-${createHash("sha256").update(tick.schedule).digest("hex").slice(0, 8)}`,
    }
  } catch {
    return undefined
  }
}
