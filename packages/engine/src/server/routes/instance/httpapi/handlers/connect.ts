import { Effect, Exit } from "effect"
import { IncomingMessage } from "node:http"
import { toServerResponse } from "@effect/platform-node/NodeHttpServerRequest"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConnectOwner } from "@/connect/owner"
import { InstanceHttpApi } from "../api"
import { ConnectApiError } from "../groups/connect"

const mapped = <A, R>(effect: Effect.Effect<A, ConnectOwner.Error, R>) =>
  effect.pipe(Effect.mapError((error) => new ConnectApiError({ code: error.code, message: error.message })))

/** A foreground review follows its caller; a background review releases this binding when it returns. */
const withRequestAbort = <A, E, R>(run: (signal: AbortSignal) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const source: unknown = request.source
    // Bun's node:http emits neither socket nor response close when a peer leaves after sending its body. Its
    // in-process Web Request path has a real AbortSignal and remains supported; no listener can repair this adapter.
    if (source instanceof IncomingMessage && process.versions.bun)
      return yield* new ConnectApiError({
        code: "disabled",
        message: "Connected reviews over this server's HTTP listener require the Node engine.",
      })
    if (!(source instanceof Request) && !(source instanceof IncomingMessage))
      return yield* new ConnectApiError({
        code: "disabled",
        message: "Connected reviews require a connection that supports cancellation.",
      })
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const abort = new AbortController()
        const stop = () => abort.abort()
        if (source instanceof Request) {
          if (source.signal.aborted) stop()
          source.signal.addEventListener("abort", stop, { once: true })
          return { signal: abort.signal, stop, close: () => source.signal.removeEventListener("abort", stop) }
        }
        // IncomingMessage's ordinary close can mean only that the POST body was consumed. A socket close,
        // an unfinished response close, or an aborted body means the caller actually left.
        const socket = source.socket
        const response = toServerResponse(request)
        const responseClosed = () => {
          if (!response.writableEnded) stop()
        }
        if (source.aborted || socket.destroyed || (response.destroyed && !response.writableEnded)) stop()
        source.once("aborted", stop)
        socket.once("close", stop)
        response.once("close", responseClosed)
        return {
          signal: abort.signal,
          stop,
          close: () => {
            source.off("aborted", stop)
            socket.off("close", stop)
            response.off("close", responseClosed)
          },
        }
      }),
      ({ signal }) => run(signal),
      ({ stop, close }, exit) =>
        Effect.sync(() => {
          // The HTTP waiter can be interrupted before its socket emits close. SessionRunState owns the admitted
          // fiber independently, so propagate that exit to its hub signal before removing the transport listeners.
          if (Exit.isFailure(exit)) stop()
          close()
        }),
    )
  })

export const connectHandlers = HttpApiBuilder.group(InstanceHttpApi, "connect", (handlers) =>
  Effect.gen(function* () {
    const owner = yield* ConnectOwner.Service
    return handlers
      .handle("list", ({ query }) => mapped(owner.members(query.sessionID)))
      .handle("runs", ({ query }) => mapped(owner.runs(query.sessionID)))
      .handle("get", ({ params, query }) => mapped(owner.get(params.runID, query.sessionID)))
      .handle("review", ({ params, payload }) =>
        withRequestAbort((abort) => mapped(owner.review(params.sessionID, payload, { abort }))),
      )
      .handle("directoryReview", ({ payload }) =>
        withRequestAbort((abort) => mapped(owner.directoryReview(payload, { abort }))),
      )
      .handle("cancel", ({ params, query }) => mapped(owner.cancel(params.runID, query.sessionID)))
      .handle("register", ({ payload }) => mapped(owner.register(payload)))
      .handle("dismiss", ({ params, payload }) => mapped(owner.dismiss(params.runID, payload)))
  }),
)
