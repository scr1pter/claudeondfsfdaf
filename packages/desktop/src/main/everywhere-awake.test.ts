import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { createEverywhereAwake } from "./everywhere-awake"

installFetchGuard()

test("the blocker exists only while jobs and opt-in are on and AC power is present", () => {
  let battery = false
  const started: string[] = []
  const stopped: number[] = []
  const awake = createEverywhereAwake({ onBattery: () => battery, start: (kind) => { started.push(kind); return 7 }, stop: (id) => { stopped.push(id) } })
  awake.update(true, false)
  awake.update(false, true)
  expect(started).toHaveLength(0)
  awake.update(true, true)
  awake.update(true, true)
  expect(started).toEqual(["prevent-app-suspension"])
  battery = true
  awake.update(true, true)
  expect(stopped).toEqual([7])
  battery = false
  awake.update(true, true)
  awake.dispose()
  expect(stopped).toEqual([7, 7])
})
