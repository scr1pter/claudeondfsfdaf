import { ComputerScreenshotEvents } from "@vectordevai/core/computer/screenshot-events"
import { Database } from "@vectordevai/core/database/database"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpBody, HttpServerResponse } from "effect/unstable/http"
import { Sse } from "effect/unstable/encoding"

export const WORKSPACE_SYNC_HEADER = "x-vector-workspace-sync"

/** Event results are resolved against their tool call before any media can leave the engine. */
export const payload = Effect.fn("ComputerPrivacy.payload")(function* <T>(value: T, database?: Database.Interface) {
  const source = database ?? Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  return yield* ComputerScreenshotEvents.strip(value, source)
})

/** Raw response streams outlive the request context; retain the tool-name resolver for their later pulls. */
export const projector = Effect.gen(function* () {
  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  return <T>(value: T) => ComputerScreenshotEvents.strip(value, database)
})

const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/** Guest responses retain the transcript but never the computer's screenshot bytes. */
export function response<A>(value: A): Effect.Effect<A> {
  if (!HttpServerResponse.isHttpServerResponse(value)) return payload(value)
  const type = value.headers["content-type"] ?? ""
  if (/^text\/event-stream(?:\s*;|$)/i.test(type)) {
    // Remote workspace requests authenticate as the owner upstream. Project their SSE bytes again at the guest edge.
    if (value.headers["content-encoding"]) return Effect.succeed(unavailable() as A)
    const source =
      value.body._tag === "Stream"
        ? value.body.stream
        : value.body._tag === "Uint8Array"
          ? Stream.make(value.body.body)
          : undefined
    if (!source) return Effect.succeed(unavailable() as A)
    return projector.pipe(
      Effect.map((project) => {
        const events = source.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.mapEffect((event) => {
            const decoded = json(event.data)
            if (Option.isNone(decoded))
              return Effect.fail(new Error("The transcript event could not be prepared for this viewer."))
            return project(decoded.value).pipe(Effect.map((data) => ({ ...event, data: JSON.stringify(data) })))
          }),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.setBody(
          value,
          HttpBody.stream(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText), type),
        ) as A
      }),
    )
  }
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(type) || value.body._tag === "Empty")
    return Effect.succeed(value)
  // This runs inside authorization, before response compression. Encoded proxy bodies cannot be inspected here.
  if (value.headers["content-encoding"]) return Effect.succeed(unavailable() as A)
  const body = value.body
  const text: Effect.Effect<string | undefined, unknown> =
    body._tag === "Uint8Array"
      ? Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(body.body))
      : body._tag === "Stream"
        ? body.stream.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          )
        : body._tag === "Raw" && typeof body.body === "string"
          ? Effect.succeed(body.body)
          : Effect.succeed(undefined)
  return text.pipe(
    Effect.flatMap((text) => {
      const decoded = json(text)
      if (Option.isNone(decoded)) return Effect.succeed(unavailable() as A)
      return payload(decoded.value).pipe(
        Effect.map((projected) => HttpServerResponse.setBody(value, HttpBody.jsonUnsafe(projected)) as A),
      )
    }),
    Effect.catchCause(() => Effect.succeed(unavailable() as A)),
  )
}

function unavailable() {
  return HttpServerResponse.jsonUnsafe(
    { message: "The transcript could not be prepared for this viewer." },
    { status: 500 },
  )
}

export * as ComputerPrivacy from "./computer-privacy"
