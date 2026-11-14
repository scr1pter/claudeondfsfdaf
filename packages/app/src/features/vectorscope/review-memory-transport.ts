import { Option, Schema } from "effect"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { ReviewMemoryRequestError, type ReviewMemoryTransport } from "./review-memory"

const refusal = Schema.Literals([
  "denied",
  "unavailable",
  "invalid",
  "limit",
  "stale",
  "used",
  "expired",
  "disabled",
  "not-found",
  "source-unavailable",
])
const decoded = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown, input = false): S["Type"] => {
  const result = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  if (Option.isSome(result)) return result.value
  if (input) throw new ReviewMemoryRequestError("invalid")
  throw new Error("The review-memory response could not be verified.")
}

/** The generated SDK retains its own authentication and fetch policy. Caller JSON never supplies placement. */
export function reviewMemoryTransport(input: {
  client: Pick<VectorClient, "reviewMemory">
  directory: string
  current: () => boolean
  denied?: () => void
}): ReviewMemoryTransport {
  const client = input.client
  const directory = input.directory
  const current = (signal: AbortSignal) => {
    signal.throwIfAborted()
    if (!directory || !input.current()) throw new ReviewMemoryRequestError("unavailable")
  }
  const send = async <S extends Schema.Decoder<unknown>>(
    signal: AbortSignal,
    schema: S,
    request: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
  ): Promise<S["Type"]> => {
    current(signal)
    const result = await request().catch((cause: unknown) => {
      current(signal)
      if (cause instanceof Error && /Server responded with text\/html/.test(cause.message))
        throw new ReviewMemoryRequestError("unavailable")
      // A transport failure can follow a committed confirmation. Keep it uncertain, without retaining raw error text.
      throw new Error("The review-memory request did not return a verified response.")
    })
    current(signal)
    const status = result.response?.status
    if (status === 401 || status === 403) {
      input.denied?.()
      throw new ReviewMemoryRequestError("denied")
    }
    if (status !== 200 || result.error !== undefined) {
      const code =
        result.error && typeof result.error === "object"
          ? Object.getOwnPropertyDescriptor(result.error, "code")
          : undefined
      const known = code && "value" in code ? Schema.decodeUnknownOption(refusal)(code.value) : Option.none()
      if (Option.isSome(known)) throw new ReviewMemoryRequestError(known.value)
      if (status === 404) throw new ReviewMemoryRequestError("unavailable")
      if (status === 400) throw new ReviewMemoryRequestError("invalid")
      throw new Error("The review-memory request did not return a verified response.")
    }
    return decoded(schema, result.data)
  }
  return Object.freeze({
    inspect: (unknown: ReviewMemoryControl.InspectInput, signal: AbortSignal) => {
      current(signal)
      const query = decoded(ReviewMemoryControl.InspectInput, unknown, true)
      return send(signal, ReviewMemoryControl.Inspect, () =>
        client.reviewMemory.inspect(
          {
            directory,
            ...(query.offset === undefined ? {} : { offset: String(query.offset) }),
            ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
          },
          { signal, throwOnError: false },
        ),
      )
    },
    prepare: (unknown: ReviewMemoryControl.Prepare, signal: AbortSignal) => {
      current(signal)
      const request = decoded(ReviewMemoryControl.Prepare, unknown, true)
      const command = request.command
      // The generated SDK accepts mutable wire arrays. Allocate them from the strictly decoded snapshot; neither
      // the SDK nor a later caller edit may mutate/retarget the canonical readonly request.
      const payload = {
        expectedScope: request.expectedScope,
        command:
          command.action === "record"
            ? {
                ...command,
                paths: [...command.paths],
                citations: command.citations.map((citation) => ({ ...citation })),
              }
            : { ...command },
      }
      return send(signal, ReviewMemoryControl.Preview, () =>
        client.reviewMemory.prepare(
          { directory, reviewMemoryControlPrepare: payload },
          { signal, throwOnError: false },
        ),
      )
    },
    confirm: (unknown: ReviewMemoryControl.Confirmation, signal: AbortSignal) => {
      current(signal)
      const request = decoded(ReviewMemoryControl.Confirmation, unknown, true)
      return send(signal, ReviewMemoryControl.ConfirmationResult, () =>
        client.reviewMemory.confirm(
          { directory, reviewMemoryControlConfirmation: request },
          { signal, throwOnError: false },
        ),
      )
    },
    discard: async (unknown: string, signal: AbortSignal) => {
      current(signal)
      const previewId = decoded(ReviewMemoryControl.PreviewID, unknown, true)
      if (
        !(await send(signal, Schema.Boolean, () =>
          client.reviewMemory.discard({ directory, previewId }, { signal, throwOnError: false }),
        ))
      )
        throw new Error("The review-memory preview could not be verified as discarded.")
    },
  })
}
