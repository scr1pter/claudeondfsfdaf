import { NodeHttpClient } from "@vectordevai/core/effect/platform-node"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { Computer } from "@vectordevai/schema/computer"

export class ComputerError extends Schema.TaggedErrorClass<ComputerError>()("ComputerError", {
  code: Computer.ComputerErrorCode,
  message: Schema.String,
}) {}

export type Response<C extends Computer.BridgeCommandName> = (typeof Computer.BridgeCommands)[C]["response"]["Type"]
export type Options = { signal?: AbortSignal; backend?: "local" | "remote" }

export interface Interface {
  readonly request: <R extends Computer.BridgeRequest>(
    input: R,
    options?: Options,
  ) => Effect.Effect<Response<R["command"]>, ComputerError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ComputerTransport") {}
export const use = serviceUse(Service)

/** The helper's complete step budgets, including its final settle and capture, plus transport slack. */
export function actDeadline(steps: readonly Computer.Step[], settleMs: number) {
  return (
    steps.reduce(
      (total, step) =>
        total +
        (step.kind === "wait"
          ? step.ms
          : Computer.LIMITS.inputStepMs + (step.kind === "key" ? (step.holdMs ?? 0) * step.repeat : 0)),
      0,
    ) +
    settleMs +
    Computer.LIMITS.captureMs +
    Computer.LIMITS.actSlackMs
  )
}

const decodeRequest = Schema.decodeUnknownEffect(Computer.BridgeRequest)
const decodeFailure = Schema.decodeUnknownOption(Computer.BridgeFailure)
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const post = Effect.fn("ComputerTransport.post")(function* <R extends Computer.BridgeRequest>(
      input: R,
      bridge: { url: string; token: string },
    ) {
      const body = JSON.stringify(input)
      if (Buffer.byteLength(body) > Computer.LIMITS.bridgeBodyBytes)
        return yield* new ComputerError({ code: "failed", message: "The computer request is too large." })
      // This labels only the already validated loopback IPC. Cleanup must still reach the desktop when Hands is off.
      const decision = Egress.decide({
        source: "computer-bridge",
        url: bridge.url,
        method: "POST",
        tool: "computer",
        bytes: Buffer.byteLength(body),
      })
      if (decision.decision !== "allow")
        return yield* new ComputerError({ code: "unavailable", message: "The local computer bridge is unavailable." })
      const response = yield* http
        .execute(
          HttpClientRequest.post(bridge.url).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${bridge.token}`,
              [Computer.BRIDGE.protocolHeader]: String(Computer.PROTOCOL),
            }),
            HttpClientRequest.bodyText(body, "application/json"),
          ),
        )
        .pipe(
          Effect.mapError(
            () => new ComputerError({ code: "unavailable", message: "The computer bridge is unavailable." }),
          ),
        )
      if (response.status === 404 || response.status === 401 || response.status === 426)
        return yield* new ComputerError({
          code: "unavailable",
          message: "The computer bridge is unavailable or incompatible.",
        })
      const text = yield* response.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(Computer.LIMITS.bridgeResponseBytes)),
        Effect.mapError(
          () => new ComputerError({ code: "failed", message: "The computer bridge response could not be read." }),
        ),
      )
      if (Buffer.byteLength(text) > Computer.LIMITS.bridgeResponseBytes)
        return yield* new ComputerError({
          code: "frame_too_large",
          message: "The computer bridge response is too large.",
        })
      const value = yield* decodeJson(text).pipe(
        Effect.mapError(
          () => new ComputerError({ code: "failed", message: "The computer bridge returned an invalid response." }),
        ),
      )
      const failure = decodeFailure(value)
      if (Option.isSome(failure))
        return yield* new ComputerError({
          code: failure.value.code,
          message: Computer.clean(failure.value.error.replaceAll(bridge.token, "[redacted]"), 2000),
        })
      if (typeof value === "object" && value !== null && "ok" in value && value.ok === false)
        return yield* new ComputerError({ code: "failed", message: "The computer bridge refused the request." })
      if (response.status < 200 || response.status >= 300)
        return yield* new ComputerError({
          code: "failed",
          message: `The computer bridge refused the request (${response.status}).`,
        })
      // The command chooses both its request and response schema; the generic preserves that correlation for callers.
      return yield* Schema.decodeUnknownEffect(
        Computer.BridgeCommands[input.command].response as Schema.Decoder<Response<R["command"]>>,
      )(value).pipe(
        Effect.mapError(
          () => new ComputerError({ code: "failed", message: "The computer bridge returned an invalid response." }),
        ),
      )
    })

    const request: Interface["request"] = Effect.fn("ComputerTransport.request")(function* <
      R extends Computer.BridgeRequest,
    >(raw: R, options?: Options) {
      if (options?.backend === "remote")
        return yield* new ComputerError({
          code: "unavailable",
          message: "Remote computer use is not available in this build.",
        })
      const bridge = endpoint()
      if (!bridge)
        return yield* new ComputerError({ code: "unavailable", message: "The computer bridge is not available." })
      const input = (yield* decodeRequest(raw).pipe(
        Effect.mapError(() => new ComputerError({ code: "failed", message: "The computer request is invalid." })),
      )) as R

      const run = Effect.gen(function* () {
        while (true) {
          const result = yield* post(input, bridge)
          const pending = input.command === "awaitControl" && "result" in result && result.result === "pending"
          const busy = input.command === "acquire" && input.wait && "code" in result && result.code === "busy"
          if (!pending && !busy) return result
          // Desktop returns each long poll within 60 seconds. Do not disconnect a queued request between replies;
          // a disconnect means cancellation there. The delay also bounds retries from an immediately busy bridge.
          yield* Effect.sleep("100 millis")
        }
      })
      const ms =
        input.command === "act"
          ? actDeadline(input.steps, input.settleMs)
          : input.command === "handoff" || input.command === "awaitControl"
            ? undefined
            : input.command === "acquire" && input.wait
              ? 10 * 60_000
              : 30_000
      const timed =
        ms === undefined
          ? run
          : run.pipe(
              Effect.timeoutOrElse({
                duration: ms,
                orElse: () => new ComputerError({ code: "timeout", message: "The computer request timed out." }),
              }),
            )
      const cancellable = options?.signal
        ? Effect.suspend(() =>
            options.signal!.aborted
              ? new ComputerError({ code: "stopped", message: "The computer request was stopped." })
              : Effect.raceFirst(timed, aborted(options.signal!)),
          )
        : timed
      return yield* cancellable.pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) || input.command === "cancel") return Effect.void
          if (!("lease" in input) && !(input.command === "acquire" && input.wait)) return Effect.void
          const error = Cause.findErrorOption(exit.cause)
          if (
            !Cause.hasInterrupts(exit.cause) &&
            !(Option.isSome(error) && (error.value.code === "timeout" || error.value.code === "stopped"))
          )
            return Effect.void
          // Cleanup has its own short budget and never uses the already-aborted caller signal or calls request().
          return post(
            {
              v: Computer.PROTOCOL,
              command: "cancel",
              rootSessionID: input.rootSessionID,
              sessionID: input.sessionID,
              directory: input.directory,
              ...("lease" in input ? { lease: input.lease } : {}),
            },
            bridge,
          ).pipe(
            Effect.interruptible,
            Effect.timeout("5 seconds"),
            Effect.catchCause(() => Effect.void),
            Effect.asVoid,
          )
        }),
      )
    })
    return Service.of({ request })
  }),
)

// Node's HTTP client has no hidden header/body deadline. Effect owns act/acquire deadlines and ctx.abort owns user waits.
const client = NodeHttpClient.layerNodeHttpNoAgent.pipe(Layer.provide(NodeHttpClient.layerAgentOptions({ timeout: 0 })))
export const node = LayerNode.make({ service: Service, layer: layer.pipe(Layer.provide(client)), deps: [] })

function endpoint() {
  const url = process.env[Computer.BRIDGE.urlEnv]
  const token = process.env[Computer.BRIDGE.tokenEnv]
  if (!url || !token) return undefined
  const parsed = URL.parse(url)
  if (
    !parsed ||
    parsed.protocol !== "http:" ||
    parsed.hostname !== Computer.BRIDGE.host ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    return undefined
  return { url: `${parsed.origin}${Computer.BRIDGE.commandPath}`, token }
}

function aborted(signal: AbortSignal) {
  return Effect.callback<never, ComputerError>((resume) => {
    const stop = () =>
      resume(Effect.fail(new ComputerError({ code: "stopped", message: "The computer request was stopped." })))
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", stop))
  })
}

export * as ComputerTransport from "./transport"
