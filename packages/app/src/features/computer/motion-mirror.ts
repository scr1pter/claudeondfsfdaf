import type { Computer } from "@vectordevai/schema/computer"

/** The waits, in ms, before each retry of a failed read or write; after the last, the next change tries again. */
export const RETRY = [1_000, 5_000, 30_000] as const

/**
 * Keeps main's `reduceMotion` preference equal to the app's Reduced motion setting, so the glow and banner calm down
 * with the rest of Vector (UX 20). Pushes are serialized and the newest value wins. Main's value is read once, and a
 * write happens only when the app's value differs from the last value main confirmed. A failed read or write is not
 * shown to anyone: the overlay keeps main's current value, and the newest value is tried again after each wait in
 * RETRY, so a desktop that was not ready at launch still receives it. A value main answers differently is not retried.
 */
export function createComputerMotionMirror(computer: Pick<Computer.ComputerPlatform, "prefs" | "setPrefs">) {
  let confirmed: boolean | undefined
  let wanted: boolean | undefined
  let latest: boolean | undefined
  let draining = false
  let disposed = false
  let current = Promise.resolve()
  let retries = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const settle = (value: boolean) => {
    if (wanted === value) wanted = undefined
  }
  const fail = (value: boolean) => {
    settle(value)
    if (disposed || timer !== undefined || retries >= RETRY.length) return
    timer = setTimeout(() => {
      timer = undefined
      if (latest !== undefined) request(latest)
    }, RETRY[retries++])
  }
  const request = (value: boolean) => {
    wanted = value
    if (!draining) current = drain()
    return current
  }
  const drain = async () => {
    draining = true
    try {
      while (wanted !== undefined) {
        const value = wanted
        if (confirmed === undefined) {
          const settings = await computer.prefs().catch(() => undefined)
          if (settings) confirmed = settings.prefs.reduceMotion === true
          else fail(value)
          continue
        }
        if (confirmed === value) {
          retries = 0
          settle(value)
          continue
        }
        // Only main's answer says what it holds; a rejected write leaves the last confirmed value in place.
        const saved = await computer.setPrefs({ reduceMotion: value }).catch(() => undefined)
        if (!saved) {
          fail(value)
          continue
        }
        confirmed = saved.prefs.reduceMotion === true
        retries = 0
        settle(value)
      }
    } finally {
      // Cleared in the same step as the last check of `wanted`, so a later push always starts a new drain.
      draining = false
    }
  }

  return {
    /** Resolves once every value pushed so far has been handled. A new value starts a fresh set of retries. */
    push(value: boolean) {
      latest = value
      retries = 0
      clearTimeout(timer)
      timer = undefined
      return request(value)
    },
    /** Cancels a pending retry. */
    dispose() {
      disposed = true
      clearTimeout(timer)
      timer = undefined
    },
  }
}
