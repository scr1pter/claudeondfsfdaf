import { describe, expect, mock, test, vi } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { createFakeComputer } from "./fake-platform"
import { createComputerMotionMirror, RETRY } from "./motion-mirror"

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

describe("reduced motion mirror", () => {
  test("a value main already holds writes nothing, and the preference is read once", async () => {
    const fake = createFakeComputer({ prefs: { reduceMotion: false } })
    const prefs = mock(fake.prefs)
    const mirror = createComputerMotionMirror({ ...fake, prefs })
    await mirror.push(false)
    await mirror.push(false)
    expect(fake.calls).toEqual([])
    expect(prefs).toHaveBeenCalledTimes(1)
  })

  test("a different value is written once, then remembered", async () => {
    const fake = createFakeComputer({ prefs: { reduceMotion: false } })
    const mirror = createComputerMotionMirror(fake)
    await mirror.push(true)
    await mirror.push(true)
    expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { reduceMotion: true } }])
    expect((await fake.prefs()).prefs.reduceMotion).toBe(true)
  })

  test("rapid toggles end on the last value without writing a stale one", async () => {
    const fake = createFakeComputer({ prefs: { reduceMotion: false } })
    const gate = Promise.withResolvers<void>()
    const mirror = createComputerMotionMirror({
      prefs: async () => {
        await gate.promise
        return fake.prefs()
      },
      setPrefs: fake.setPrefs,
    })
    const first = mirror.push(true)
    mirror.push(false)
    mirror.push(true)
    const last = mirror.push(false)
    gate.resolve()
    await Promise.all([first, last])
    // The newest value equals main's, so nothing is written at all.
    expect(fake.calls).toEqual([])

    const slow = Promise.withResolvers<void>()
    let writes = 0
    const second = createFakeComputer({ prefs: { reduceMotion: false } })
    const toggled = createComputerMotionMirror({
      prefs: second.prefs,
      setPrefs: async (patch) => {
        if (writes++ === 0) await slow.promise
        return second.setPrefs(patch)
      },
    })
    const running = toggled.push(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    toggled.push(false)
    toggled.push(true)
    toggled.push(false)
    slow.resolve()
    await running
    expect(second.calls).toEqual([
      { method: "setPrefs", prefs: { reduceMotion: true } },
      { method: "setPrefs", prefs: { reduceMotion: false } },
    ])
    expect((await second.prefs()).prefs.reduceMotion).toBe(false)
  })

  test("a failed read does not throw, and the next change reads and writes", async () => {
    const fake = createFakeComputer({ prefs: { reduceMotion: false } })
    let fail = true
    const mirror = createComputerMotionMirror({
      prefs: () => (fail ? Promise.reject(new Error("main is starting")) : fake.prefs()),
      setPrefs: fake.setPrefs,
    })
    await mirror.push(true)
    expect(fake.calls).toEqual([])
    fail = false
    await mirror.push(true)
    expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { reduceMotion: true } }])
  })

  test("a rejected write is not taken as main's value", async () => {
    const fake = createFakeComputer({ prefs: { reduceMotion: false } })
    let reject = true
    const setPrefs = mock((patch: Partial<Computer.ComputerPrefs>) =>
      reject ? Promise.reject(new Error("store is read-only")) : fake.setPrefs(patch),
    )
    const mirror = createComputerMotionMirror({ prefs: fake.prefs, setPrefs })
    await mirror.push(true)
    expect(setPrefs).toHaveBeenCalledTimes(1)
    reject = false
    // Main still holds false, so going back to false writes nothing and going forward writes once.
    await mirror.push(false)
    expect(setPrefs).toHaveBeenCalledTimes(1)
    await mirror.push(true)
    expect(setPrefs).toHaveBeenCalledTimes(2)
    expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { reduceMotion: true } }])
  })

  test("main's answer wins when it keeps a different value", async () => {
    const fake = createFakeComputer({ prefs: { reduceMotion: false }, locked: ["reduceMotion"] })
    const setPrefs = mock(fake.setPrefs)
    const mirror = createComputerMotionMirror({ prefs: fake.prefs, setPrefs })
    await mirror.push(true)
    await mirror.push(true)
    // Main answered false, so the same push is tried again rather than assumed to have landed.
    expect(setPrefs).toHaveBeenCalledTimes(2)
    await mirror.push(false)
    expect(setPrefs).toHaveBeenCalledTimes(2)
  })

  test("a read or write that fails while main is starting is retried without another change of the setting", async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakeComputer({ prefs: { reduceMotion: false } })
      let unready = 2
      const prefs = mock(() => (unready-- > 0 ? Promise.reject(new Error("main is starting")) : fake.prefs()))
      const mirror = createComputerMotionMirror({ prefs, setPrefs: fake.setPrefs })
      await mirror.push(true)
      expect(prefs).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(RETRY[0] - 1)
      await flush()
      expect(prefs).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      await flush()
      expect(prefs).toHaveBeenCalledTimes(2)
      expect(fake.calls).toEqual([])
      vi.advanceTimersByTime(RETRY[1])
      await flush()
      expect(prefs).toHaveBeenCalledTimes(3)
      expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { reduceMotion: true } }])

      // A failed write is retried the same way, with the newest value.
      let reject = true
      const setPrefs = mock((patch: Partial<Computer.ComputerPrefs>) =>
        reject ? Promise.reject(new Error("main is starting")) : fake.setPrefs(patch),
      )
      const second = createComputerMotionMirror({ prefs: fake.prefs, setPrefs })
      await second.push(false)
      expect(setPrefs).toHaveBeenCalledTimes(1)
      reject = false
      vi.advanceTimersByTime(RETRY[0])
      await flush()
      expect(setPrefs).toHaveBeenCalledTimes(2)
      expect((await fake.prefs()).prefs.reduceMotion).toBe(false)
      vi.advanceTimersByTime(60_000)
      await flush()
      expect(setPrefs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test("retries stop after the last wait or on dispose, and the next change of the setting tries again", async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakeComputer({ prefs: { reduceMotion: false } })
      let reject = true
      const setPrefs = mock((patch: Partial<Computer.ComputerPrefs>) =>
        reject ? Promise.reject(new Error("store is read-only")) : fake.setPrefs(patch),
      )
      const mirror = createComputerMotionMirror({ prefs: fake.prefs, setPrefs })
      await mirror.push(true)
      for (const wait of RETRY) {
        vi.advanceTimersByTime(wait)
        await flush()
      }
      expect(setPrefs).toHaveBeenCalledTimes(1 + RETRY.length)
      vi.advanceTimersByTime(10 * 60_000)
      await flush()
      expect(setPrefs).toHaveBeenCalledTimes(1 + RETRY.length)
      reject = false
      await mirror.push(true)
      expect(setPrefs).toHaveBeenCalledTimes(2 + RETRY.length)
      expect(fake.calls).toEqual([{ method: "setPrefs", prefs: { reduceMotion: true } }])

      reject = true
      await mirror.push(false)
      mirror.dispose()
      vi.advanceTimersByTime(10 * 60_000)
      await flush()
      expect(setPrefs).toHaveBeenCalledTimes(3 + RETRY.length)
    } finally {
      vi.useRealTimers()
    }
  })
})
