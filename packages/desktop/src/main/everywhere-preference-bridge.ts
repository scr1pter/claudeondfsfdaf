import { randomUUID } from "node:crypto"
import { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"
import { Option, Schema } from "effect"

export const PREFERENCE_MESSAGE = "everywhere-preferences"
export const SESSION_MESSAGE = "everywhere-session"
const unavailable = { version: 1, kind: "unavailable" } as const

type Transport = {
  send: (message: unknown) => void
  listen: (callback: (message: unknown) => void) => () => void
}

export function preferenceRequester(transport: Transport) {
  return requester<EverywherePreferenceWire.Request, EverywherePreferenceWire.Result>(
    transport,
    PREFERENCE_MESSAGE,
    Schema.decodeUnknownOption(EverywherePreferenceWire.Result),
    unavailable,
  )
}

export function sessionRequester(transport: Transport) {
  return requester<EverywhereSessionWire.Request, EverywhereSessionWire.Result>(
    transport,
    SESSION_MESSAGE,
    Schema.decodeUnknownOption(EverywhereSessionWire.Result),
    unavailable,
  )
}

function requester<Request, Result>(
  transport: Transport,
  type: string,
  decode: (value: unknown) => Option.Option<Result>,
  failed: Result,
) {
  return (request: Request): Promise<Result> =>
    new Promise((resolve) => {
      const id = randomUUID()
      const finish = (result: Result) => {
        clearTimeout(timer)
        stop()
        resolve(result)
      }
      const stop = transport.listen((message) => {
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== type) return
        if (!("id" in message) || message.id !== id || !("result" in message)) return
        finish(Option.getOrElse(decode(message.result), () => failed))
      })
      const timer = setTimeout(() => finish(failed), 10_000)
      try {
        transport.send({ type, id, request })
      } catch {
        finish(failed)
      }
    })
}

export function preferenceMessage(message: unknown) {
  return requestMessage(message, PREFERENCE_MESSAGE)
}

export function requestMessage(message: unknown, type: string) {
  if (typeof message !== "object" || message === null || !("type" in message) || message.type !== type) return
  if (!("id" in message) || typeof message.id !== "string" || !("request" in message)) return
  return { id: message.id, request: message.request }
}
