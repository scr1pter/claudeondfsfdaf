import { isUtf8 } from "node:buffer"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

// What the Hands bridge accepts from the engine (contract section 2.8). The shared schemas already bound every
// string, pin `v: 1`, the 1 to 10 act steps and the `ui_N` ref pattern; this module only adds the strict edges:
// bytes must be UTF-8 and no unknown field is accepted, at any depth.

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Computer.BridgeRequest), {
  onExcessProperty: "error",
})

/** A `POST /computer` body, or undefined when it is not one valid bridge request. */
export function parseBridgeRequest(bytes: Uint8Array) {
  if (!isUtf8(bytes)) return undefined
  // ignoreBOM keeps a leading byte-order mark in the text, so JSON parsing refuses it instead of skipping it.
  return Option.getOrUndefined(decodeRequest(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)))
}

/** Whether a `Vector-Computer-Protocol` header names a version this build speaks: one decimal integer in range. */
export function parseProtocol(header: string | string[] | undefined) {
  if (typeof header !== "string" || !/^[1-9]\d{0,8}$/.test(header)) return false
  return Number(header) <= Computer.PROTOCOL
}
