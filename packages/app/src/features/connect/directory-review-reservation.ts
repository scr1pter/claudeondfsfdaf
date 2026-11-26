import type { Connect } from "@vectordevai/schema/connect"

// An advisory age for the default engine replay window, never proof that a server still retains a request.
const REPLAY_NOTICE_MS = 24 * 60 * 60_000

/** An unpaid admission marker. A retry must keep the identity captured before its first POST. */
export function createDirectoryReviewReservation(input: {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  key: string
  body: Omit<Connect.DirectoryReviewInput, "requestKey">
  requestKey: () => string
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const read = () => {
    const raw = input.storage.getItem(input.key)
    if (raw === null) return
    const value: unknown = JSON.parse(raw)
    if (
      !value ||
      typeof value !== "object" ||
      !("requestKey" in value) ||
      typeof value.requestKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestKey) ||
      Object.keys(value).length !== ("savedAt" in value ? 4 : 3) ||
      ("savedAt" in value &&
        (typeof value.savedAt !== "number" || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0)) ||
      !("target" in value) ||
      !("background" in value) ||
      JSON.stringify({ target: value.target, background: value.background }) !== JSON.stringify(input.body)
    )
      throw new Error("The saved review request does not match this workspace.")
    return {
      raw,
      input: { requestKey: value.requestKey, ...input.body },
      savedAt: "savedAt" in value && typeof value.savedAt === "number" ? value.savedAt : undefined,
    }
  }
  // Capture a retained request when remounting too, before history or another view can change its marker.
  let retained = read()
  // Only the exact request this view captured is cleared; a marker another view wrote stays.
  const clear = () => {
    if (!retained || input.storage.getItem(input.key) !== retained.raw)
      throw new Error("The saved review request changed.")
    input.storage.removeItem(input.key)
    retained = undefined
  }
  return {
    /** A warning only: it neither expires the key nor claims that a fresh timestamp guarantees replay. */
    retryWarning: () => {
      if (!retained) return undefined
      const current = now()
      if (retained.savedAt === undefined || !Number.isSafeInteger(current) || current < 0)
        return "This saved request's age is unknown. If the engine no longer retains it, retrying can start a new review."
      if (retained.savedAt > current)
        return "This saved request's timestamp is in the future. Its replay age cannot be verified, so retrying can start a new review."
      if (current - retained.savedAt >= REPLAY_NOTICE_MS)
        return "This saved request is at least 24 hours old. The engine may no longer retain it, so retrying can start a new review."
      return "A retry sends the same saved request. If the engine no longer retains it, retrying can start a new review."
    },
    pending: () => {
      try {
        return retained !== undefined || input.storage.getItem(input.key) !== null
      } catch {
        return true
      }
    },
    hold: (retry: boolean) => {
      const saved = read()
      if (retry) {
        if (!retained || !saved || retained.raw !== saved.raw)
          throw new Error("The original review request can no longer be verified.")
        return
      }
      if (retained && retained.raw !== saved?.raw) throw new Error("The saved review request changed before admission.")
      if (saved) {
        retained = saved
        return
      }
      const savedAt = now()
      if (!Number.isSafeInteger(savedAt) || savedAt < 0)
        throw new Error("The review request timestamp could not be saved.")
      const raw = JSON.stringify({ requestKey: input.requestKey(), ...input.body, savedAt })
      input.storage.setItem(input.key, raw)
      retained = read()
      if (!retained) throw new Error("The review request was not saved before admission.")
    },
    request: () => {
      if (!retained) throw new Error("The review request was not saved before admission.")
      return retained.input
    },
    confirm: clear,
    /** The engine answered `consumed` for this exact request: no review ran, and the next hold(false) mints a new key. */
    discard: () => {
      // Another view in this tab already confirmed or discarded the marker, so nothing is left to protect.
      if (input.storage.getItem(input.key) === null) {
        retained = undefined
        return
      }
      clear()
    },
  }
}
