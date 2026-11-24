import { randomUUID } from "node:crypto"
import { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { Option, Schema } from "effect"

export const PREFERENCE_MESSAGE = "everywhere-preferences"
const unavailable = { version: 1, kind: "unavailable" } as const

type Transport = {
  send: (message: unknown) => void
  listen: (callback: (message: unknown) => void) => () => void
}

export function preferenceRequester(transport: Transport) {
  return (request: EverywherePreferenceWire.Request): Promise<EverywherePreferenceWire.Result> =>
    new Promise((resolve) => {
      const id = randomUUID()
      const finish = (result: EverywherePreferenceWire.Result) => {
        clearTimeout(timer)
        stop()
        resolve(result)
      }
      const stop = transport.listen((message) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== PREFERENCE_MESSAGE
        )
          return
        if (!("id" in message) || message.id !== id || !("result" in message)) return
        finish(
          Option.getOrElse(
            Schema.decodeUnknownOption(EverywherePreferenceWire.Result)(message.result),
            () => unavailable,
          ),
        )
      })
      const timer = setTimeout(() => finish(unavailable), 10_000)
      try {
        transport.send({ type: PREFERENCE_MESSAGE, id, request })
      } catch {
        finish(unavailable)
      }
    })
}

export function preferenceMessage(message: unknown) {
  if (typeof message !== "object" || message === null || !("type" in message) || message.type !== PREFERENCE_MESSAGE)
    return
  if (!("id" in message) || typeof message.id !== "string" || !("request" in message)) return
  return { id: message.id, request: message.request }
}
