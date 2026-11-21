import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { afterEach, expect, test } from "bun:test"
import { createEverywhereAwake } from "./everywhere-awake"
import { holdDesktopWork, setDesktopWorkBlocker, whileDesktopWorks } from "./keep-awake"

// The stay-awake option (spec §3.5 step 10, F6) holds the desktop's one shared work blocker, the one index.ts sets
// with setDesktopWorkBlocker, never one of its own. The blocker and the power source are fakes.

installFetchGuard()
const cleanup: (() => void)[] = []
// keep-awake.ts keeps its holders and blocker for the whole process: every case releases what it held.
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release()
  setDesktopWorkBlocker(undefined)
})

function blocker() {
  const calls: string[] = []
  const state = { next: 0 }
  setDesktopWorkBlocker({
    start: () => {
      state.next += 1
      calls.push(`start ${state.next}`)
      return state.next
    },
    stop: (id) => void calls.push(`stop ${id}`),
  })
  return calls
}

function power() {
  const listeners = new Set<() => void>()
  const source = {
    battery: false,
    subscribed: 0,
    listeners,
    changed: (listener: () => void) => {
      source.subscribed += 1
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onBattery: () => source.battery,
    /** The power source changes; every subscribed listener hears it. */
    set(battery: boolean) {
      source.battery = battery
      for (const listener of [...listeners]) listener()
    },
  }
  return source
}

function awakeOn(source: ReturnType<typeof power>) {
  const awake = createEverywhereAwake({ onBattery: source.onBattery, changed: source.changed })
  cleanup.push(awake.dispose)
  return awake
}

test("the shared blocker is held only while jobs and the option are on and the computer is on AC power", () => {
  const calls = blocker()
  const source = power()
  const awake = awakeOn(source)
  awake.update(true, false)
  awake.update(false, true)
  expect(calls).toEqual([])
  // Power is not even watched until both are on.
  expect(source.subscribed).toBe(0)
  awake.update(true, true)
  awake.update(true, true)
  expect(calls).toEqual(["start 1"])
  expect(source.listeners.size).toBe(1)
  // Unplugged: released at the power event, with no settings change.
  source.set(true)
  expect(calls).toEqual(["start 1", "stop 1"])
  awake.update(true, true)
  expect(calls).toEqual(["start 1", "stop 1"])
  // Plugged in again.
  source.set(false)
  expect(calls).toEqual(["start 1", "stop 1", "start 2"])
  // Jobs off: released, and power is no longer watched.
  awake.update(false, true)
  expect(calls).toEqual(["start 1", "stop 1", "start 2", "stop 2"])
  expect(source.listeners.size).toBe(0)
  source.set(false)
  expect(calls).toEqual(["start 1", "stop 1", "start 2", "stop 2"])
  // The option off works the same way, and dispose releases.
  awake.update(true, true)
  awake.update(true, false)
  awake.update(true, true)
  awake.dispose()
  expect(calls).toEqual(["start 1", "stop 1", "start 2", "stop 2", "start 3", "stop 3", "start 4", "stop 4"])
  expect(source.listeners.size).toBe(0)
  expect(source.subscribed).toBe(3)
})

test("on battery, or with stay_awake off, nothing is held", () => {
  const calls = blocker()
  const source = power()
  source.battery = true
  const awake = awakeOn(source)
  awake.update(true, true)
  awake.update(true, true)
  awake.update(true, false)
  awake.update(false, false)
  awake.dispose()
  expect(calls).toEqual([])
})

test("jobs and the desktop's own work share one blocker, released only once both are idle", async () => {
  const calls = blocker()
  const source = power()
  const awake = awakeOn(source)
  // Jobs first, then a workspace's checks (whileDesktopWorks): one blocker for both.
  awake.update(true, true)
  const checks = Promise.withResolvers<void>()
  const work = whileDesktopWorks(() => checks.promise)
  expect(calls).toEqual(["start 1"])
  // Jobs go off while the checks still run: the blocker stays.
  awake.update(false, true)
  expect(calls).toEqual(["start 1"])
  checks.resolve()
  await work
  expect(calls).toEqual(["start 1", "stop 1"])

  // The checks first, then jobs: the checks end, and the blocker stays for the jobs until the computer is unplugged.
  const more = Promise.withResolvers<void>()
  const second = whileDesktopWorks(() => more.promise)
  awake.update(true, true)
  expect(calls).toEqual(["start 1", "stop 1", "start 2"])
  more.resolve()
  await second
  expect(calls).toEqual(["start 1", "stop 1", "start 2"])
  source.set(true)
  expect(calls).toEqual(["start 1", "stop 1", "start 2", "stop 2"])
})

test("a hold's release works once, and never releases another holder's hold", () => {
  const calls = blocker()
  const first = holdDesktopWork()
  const second = holdDesktopWork()
  cleanup.push(first, second)
  expect(calls).toEqual(["start 1"])
  first()
  first()
  expect(calls).toEqual(["start 1"])
  second()
  expect(calls).toEqual(["start 1", "stop 1"])
  second()
  expect(calls).toEqual(["start 1", "stop 1"])
})

test("a hold taken before the blocker is set is honoured once index.ts sets it", () => {
  const release = holdDesktopWork()
  cleanup.push(release)
  const calls = blocker()
  expect(calls).toEqual(["start 1"])
  release()
  expect(calls).toEqual(["start 1", "stop 1"])
})
