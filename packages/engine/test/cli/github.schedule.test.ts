import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lookupSchedule } from "../../src/cli/cmd/github.schedule"
import { agentRoute } from "../../src/cli/cmd/github.agent"

const cron = "17 9 * * 1-5"
const env = { VECTOR_SCHEDULE_PROMPTS: JSON.stringify({ [cron]: { id: "daily", prompt: "Review the repository" } }) }

test("a tick resolves only its trusted configured prompt, id and stable conversation thread", () => {
  expect(lookupSchedule(env, { schedule: cron })).toEqual({
    id: "daily",
    prompt: "Review the repository",
    cron,
    thread: `schedule-${createHash("sha256").update(cron).digest("hex").slice(0, 8)}`,
  })
  expect(agentRoute({ name: "schedule", payload: { schedule: cron } }, env)).toMatchObject({
    route: { kind: "schedule", scheduleId: "daily", trigger: "Review the repository", review: false },
  })
})

test("unknown, prototype, malformed or ambiguous schedule maps refuse without a prompt", () => {
  for (const schedule of ["unknown", "constructor", "toString", "__proto__"])
    expect(lookupSchedule(env, { schedule })).toBeUndefined()
  for (const text of [
    "not-json",
    JSON.stringify({ [cron]: { id: "daily", prompt: "task", extra: true } }),
    JSON.stringify({ [cron]: { id: "daily", prompt: "one" }, "18 9 * * 1-5": { id: "daily", prompt: "two" } }),
    JSON.stringify({ "60 9 * * *": { id: "daily", prompt: "one" } }),
    JSON.stringify({ [cron]: { id: "daily\n", prompt: "one" } }),
  ])
    expect(lookupSchedule({ VECTOR_SCHEDULE_PROMPTS: text }, { schedule: cron })).toBeUndefined()
})
