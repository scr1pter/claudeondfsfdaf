import type { Connect } from "@vectordevai/schema/connect"

/** An unpaid admission marker. A retry must keep the identity captured before its first POST. */
export function createDirectoryReviewReservation(input: {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  key: string
  body: Omit<Connect.DirectoryReviewInput, "requestKey">
  requestKey: () => string
}) {
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
      Object.keys(value).length !== 3 ||
      !("target" in value) ||
      !("background" in value) ||
      JSON.stringify({ target: value.target, background: value.background }) !== JSON.stringify(input.body)
    )
      throw new Error("The saved review request does not match this workspace.")
    return { raw, input: { requestKey: value.requestKey, ...input.body } }
  }
  // Capture a retained request when remounting too, before history or another view can change its marker.
  let retained = read()
  return {
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
      const raw = JSON.stringify({ requestKey: input.requestKey(), ...input.body })
      input.storage.setItem(input.key, raw)
      retained = read()
      if (!retained) throw new Error("The review request was not saved before admission.")
    },
    request: () => {
      if (!retained) throw new Error("The review request was not saved before admission.")
      return retained.input
    },
    confirm: () => {
      if (!retained || input.storage.getItem(input.key) !== retained.raw)
        throw new Error("The saved review request changed.")
      input.storage.removeItem(input.key)
      retained = undefined
    },
  }
}
