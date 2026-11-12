import { expect, test } from "bun:test"
import { cronFor, scheduleId, spreadScheduleMinutes, UTC_SCHEDULE_NOTE, validCron } from "../../src/review/schedule"

test("local daily, weekday and weekly recurrences convert to the correct UTC clock and weekday", () => {
  const january = new Date("2026-01-15T12:00:00Z")
  expect(cronFor({ kind: "daily", time: "08:00" }, "America/Los_Angeles", january)?.cron).toBe("0 16 * * *")
  expect(cronFor({ kind: "daily", time: "08:00" }, "Asia/Kolkata", january)?.cron).toBe("30 2 * * *")
  expect(cronFor({ kind: "weekdays", time: "23:30" }, "America/Los_Angeles", january)?.cron).toBe("30 7 * * 2,3,4,5,6")
  expect(cronFor({ kind: "weekly", weekday: 1, time: "01:00" }, "Pacific/Auckland", january)?.cron).toBe("0 12 * * 0")
  expect(cronFor({ kind: "daily", time: "00:00" }, "UTC", january)?.cron).toBe("0 0 * * *")
})

test("the UTC conversion explicitly warns about daylight-saving drift", () => {
  const recurrence = { kind: "daily" as const, time: "08:00" }
  expect(cronFor(recurrence, "America/Los_Angeles", new Date("2026-07-15T12:00:00Z"))?.cron).toBe("0 15 * * *")
  expect(cronFor(recurrence, "America/Los_Angeles", new Date("2026-01-15T12:00:00Z"))?.note).toBe(UTC_SCHEDULE_NOTE)
  expect(UTC_SCHEDULE_NOTE).toContain("±1 hour")
})

test("one-shots, malformed clocks/weekdays and unknown time zones are refused", () => {
  expect(cronFor({ kind: "once", at: "2026-12-01T00:00:00Z" }, "UTC")).toBeUndefined()
  for (const time of ["25:00", "09:60", "-1:20", "08:0", ""])
    expect(cronFor({ kind: "daily", time }, "UTC")).toBeUndefined()
  expect(cronFor({ kind: "weekly", weekday: 7, time: "08:00" }, "UTC")).toBeUndefined()
  expect(cronFor({ kind: "daily", time: "08:00" }, "Unknown/Zone")).toBeUndefined()
})

test("two schedules on the same cron retain their stable ids and receive distinct minutes", () => {
  expect(
    spreadScheduleMinutes([
      { id: "daily-a", cron: "0 8 * * *", prompt: "first" },
      { id: "daily-b", cron: "0 8 * * *", prompt: "second" },
      { id: "daily-c", cron: "1 8 * * *", prompt: "third" },
    ]),
  ).toEqual([
    { id: "daily-a", cron: "0 8 * * *", prompt: "first" },
    { id: "daily-b", cron: "1 8 * * *", prompt: "second" },
    { id: "daily-c", cron: "2 8 * * *", prompt: "third" },
  ])
  expect(() => scheduleId("../../outside")).toThrow()
  expect(() => scheduleId("daily\n")).toThrow()
  expect(() =>
    spreadScheduleMinutes([
      { id: "same", cron: "0 8 * * *" },
      { id: "same", cron: "0 9 * * *" },
    ]),
  ).toThrow()
})

test("cron calendar fields refuse impossible numbers, reversed ranges and zero steps", () => {
  for (const cron of [
    "60 8 * * *",
    "0 24 * * *",
    "0 8 0 * *",
    "0 8 * 13 *",
    "0 8 * * 7",
    "*/0 8 * * *",
    "20-10 8 * * *",
  ])
    expect(validCron(cron)).toBe(false)
  for (const cron of ["*/15 8-17 * * 1-5", "0 8 1,15 * *", "30 23 * * 0,6", "0 0 * * *"])
    expect(validCron(cron)).toBe(true)
})
