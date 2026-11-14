import { readFileSync } from "node:fs"

import { Exit, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

/**
 * Vector Hands helper protocol framing and the shared conformance replay driver (build contract 2.10 and 2.11).
 *
 * Framing: each message is a 4-byte big-endian length and a UTF-8 JSON body; an image response is a JSON header with
 * `imageBytes: N` followed by one binary frame of N bytes.
 *
 * Transcripts (`test/fixtures/computer-protocol/*.jsonl`) hold one `{send, expect}` per line, at message level, so
 * the fake helper, both native helpers (C2's self-test) and D14's conformance test replay the same lines. `send` is
 * a request object or a directive: `{"$raw": text}` sends a frame with that body, `{"$oversize": n}` a frame header
 * declaring n bytes followed by n filler bytes, `{"$wait": ms}` waits, `{"$eof": true}` closes the channel.
 * `expect` is one message, an ordered array of messages, `null` (nothing arrives) or `{"$exit": {withinMs, code?}}`;
 * an array may end with `$exit`. A message matches when every expected field matches (a subset match, arrays
 * element by element), where `"$any"` matches any present value. Before matching, every received frame must decode:
 * a response with the schema of the op its id was sent with, a failure as `HelperFailure` (id 0 for one that cannot
 * be attributed), anything without an id as `HelperEvent`.
 *
 * Events may arrive at any time (2.10), and a helper on a runner without OS grants may legitimately report one, such
 * as `input_detection {alive: false}` when a foreground session starts. So an event that decodes is skipped, and
 * returned in `events`, while a line waits for a response, for nothing (`null`) or for an exit; a line that expects
 * an event skips only events of other kinds. A frame that does not decode still fails, events included.
 */

// ---------------------------------------------------------------------------------------------------------------
// Framing

export function encodeFrame(body: unknown): Uint8Array {
  const bytes = body instanceof Uint8Array ? body : Buffer.from(JSON.stringify(body), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([header, bytes])
}

/**
 * A streaming frame decoder. A frame declared longer than `maxBytes` is reported once through `onOversize` and its
 * bytes are discarded as they arrive, never buffered; decoding then continues with the next frame.
 */
export function frameReader(input: {
  maxBytes?: number
  onFrame: (bytes: Uint8Array) => void
  onOversize?: (length: number) => void
}) {
  const chunks: Buffer[] = []
  const state = { size: 0, skip: 0 }
  // Consume `count` buffered bytes, copying them into `out` unless they are being discarded.
  const consume = (count: number, out?: Buffer) => {
    let filled = 0
    while (filled < count) {
      const head = chunks[0]!
      const used = Math.min(head.length, count - filled)
      if (out) head.copy(out, filled, 0, used)
      filled += used
      if (used === head.length) chunks.shift()
      else chunks[0] = head.subarray(used)
    }
    state.size -= count
    return out
  }
  const take = (count: number) => consume(count, Buffer.alloc(count))!
  return {
    push(chunk: Uint8Array) {
      // Chunks stay non-empty, so the first four always hold a frame header once four bytes are buffered.
      if (chunk.byteLength) chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      state.size += chunk.byteLength
      while (true) {
        if (state.skip > 0) {
          const dropped = Math.min(state.skip, state.size)
          consume(dropped)
          state.skip -= dropped
          if (state.skip > 0) return
        }
        if (state.size < 4) return
        const length = Buffer.concat(chunks.slice(0, 4)).readUInt32BE(0)
        if (input.maxBytes !== undefined && length > input.maxBytes) {
          consume(4)
          state.skip = length
          input.onOversize?.(length)
          continue
        }
        if (state.size < 4 + length) return
        consume(4)
        input.onFrame(take(length))
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transcripts

const Line = Schema.Struct({ send: Schema.Unknown, expect: Schema.Unknown })
export type Line = typeof Line.Type

export function readTranscript(file: string): Line[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((text) => text.trim())
    .map((text, index) => {
      const line = Schema.decodeUnknownOption(Schema.fromJsonString(Line))(text)
      if (line._tag === "None") throw new Error(`${file}:${index + 1}: not a {send, expect} line`)
      return line.value
    })
}

/** What a helper channel delivers: a raw frame, or the helper's exit. */
export type Received = { kind: "frame"; bytes: Uint8Array } | { kind: "exit"; code: number | null }

export interface Channel {
  write(bytes: Uint8Array): void
  /** Close the desktop's side of the channel (EOF for the helper). */
  end(): void
  /** The next frame or exit, or undefined when nothing arrives within `timeoutMs`. */
  next(timeoutMs: number): Promise<Received | undefined>
}

export interface ReplayOptions {
  /** Waits for `$wait`; a manual clock for an in-process fake, real time for a process. */
  wait: (ms: number) => Promise<void>
  /** How long a line expecting a message waits for it. */
  replyMs?: number
  /** How long `expect: null` listens. */
  quietMs?: number
  /** A name for errors, usually the transcript file. */
  name?: string
}

/**
 * Replay `lines` against `channel`; throws on the first line that does not match, naming it. Returns the matched
 * messages and the events skipped on the way, so a caller can still check those.
 */
export async function replay(channel: Channel, lines: readonly Line[], options: ReplayOptions) {
  const sent = new Map<number, Computer.HelperOpName | undefined>()
  const received: unknown[] = []
  const events: unknown[] = []
  for (const [index, line] of lines.entries()) {
    const where = `${options.name ?? "transcript"}:${index + 1}`
    await send(channel, line.send, sent, options)
    for (const expected of expectations(line.expect)) {
      const next = (timeoutMs: number) => nextExpected(channel, timeoutMs, sent, expected, events)
      if (expected === null) {
        const extra = await next(options.quietMs ?? 200)
        if (extra) throw new Error(`${where}: expected nothing, received ${describe(extra)}`)
        continue
      }
      const exit = exitExpectation(expected)
      if (exit) {
        const result = await next(exit.withinMs)
        if (result?.kind !== "exit")
          throw new Error(`${where}: expected exit within ${exit.withinMs} ms, got ${describe(result)}`)
        if (exit.code !== undefined && result.code !== exit.code)
          throw new Error(`${where}: expected exit code ${exit.code}, got ${result.code}`)
        continue
      }
      const result = await next(options.replyMs ?? 5_000)
      if (result?.kind !== "message")
        throw new Error(`${where}: expected ${JSON.stringify(expected)}, got ${describe(result)}`)
      const problem = result.problem
      if (problem)
        throw new Error(
          `${where}: received a frame that does not decode (${problem}): ${JSON.stringify(result.message)}`,
        )
      if (!subset(expected, result.message))
        throw new Error(`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result.message)}`)
      received.push(result.message)
    }
  }
  return { messages: received, events }
}

async function send(
  channel: Channel,
  value: unknown,
  sent: Map<number, Computer.HelperOpName | undefined>,
  options: ReplayOptions,
) {
  const directive = isRecord(value) ? value : undefined
  if (directive && typeof directive.$raw === "string")
    return channel.write(encodeFrame(Buffer.from(directive.$raw, "utf8")))
  if (directive && typeof directive.$oversize === "number") {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(directive.$oversize, 0)
    return channel.write(Buffer.concat([header, Buffer.alloc(directive.$oversize)]))
  }
  if (directive && typeof directive.$wait === "number") return options.wait(directive.$wait)
  if (directive && directive.$eof === true) return channel.end()
  // Every request id is remembered, with its op when the protocol defines it, so a refusal of an unknown op still
  // answers a request that was sent.
  if (directive && typeof directive.id === "number")
    sent.set(directive.id, typeof directive.op === "string" && isOp(directive.op) ? directive.op : undefined)
  channel.write(encodeFrame(value))
}

function expectations(expect: unknown): unknown[] {
  if (expect === null) return [null]
  return Array.isArray(expect) ? expect : [expect]
}

function exitExpectation(value: unknown) {
  if (!isRecord(value) || !isRecord(value.$exit)) return
  const exit = value.$exit
  return {
    withinMs: typeof exit.withinMs === "number" ? exit.withinMs : 1_000,
    code: typeof exit.code === "number" ? exit.code : undefined,
  }
}

/**
 * The next frame or exit within `timeoutMs`, after skipping every event that decodes and is not of the kind
 * `expected` names; skipped events go to `events`.
 */
async function nextExpected(
  channel: Channel,
  timeoutMs: number,
  sent: Map<number, Computer.HelperOpName | undefined>,
  expected: unknown,
  events: unknown[],
) {
  const deadline = Date.now() + timeoutMs
  const kind = isRecord(expected) ? expected.event : undefined
  while (true) {
    const result = await nextMessage(channel, Math.max(0, deadline - Date.now()), sent, timeoutMs)
    if (result?.kind !== "message" || result.problem || !isEvent(result.message)) return result
    if (kind !== undefined && subset(kind, result.message.event)) return result
    events.push(result.message)
  }
}

/**
 * The next decoded message, skipping the binary frame that follows an image header (waited for up to `imageMs`).
 * `problem` is set when the frame is not valid protocol output.
 */
async function nextMessage(
  channel: Channel,
  timeoutMs: number,
  sent: Map<number, Computer.HelperOpName | undefined>,
  imageMs: number,
) {
  const result = await channel.next(timeoutMs)
  if (!result) return
  if (result.kind === "exit") return result
  const message = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(result.bytes).toString("utf8"))
  if (message._tag === "None") return { kind: "message" as const, message: undefined, problem: "not JSON" }
  const problem = check(message.value, sent)
  if (!problem && isRecord(message.value) && typeof message.value.imageBytes === "number") {
    const image = await channel.next(imageMs)
    if (image?.kind !== "frame" || image.bytes.length !== message.value.imageBytes)
      return {
        kind: "message" as const,
        message: message.value,
        problem: "the image frame is missing or the wrong size",
      }
  }
  return { kind: "message" as const, message: message.value, problem }
}

function check(message: unknown, sent: Map<number, Computer.HelperOpName | undefined>) {
  if (!isRecord(message)) return "not an object"
  if (!("id" in message)) return decodes(Computer.HelperEvent, message) ? undefined : "not a HelperEvent"
  if (message.ok === false) {
    if (!decodes(Computer.HelperFailure, message)) return "not a HelperFailure"
    return message.id === 0 || sent.has(message.id as number) ? undefined : "a failure for an id that was never sent"
  }
  const op = typeof message.id === "number" ? sent.get(message.id) : undefined
  if (!op)
    return sent.has(message.id as number)
      ? "a success for an op the protocol does not define"
      : "a response for an id that was never sent"
  return decodes(Computer.helperResponse(op), message) ? undefined : `not a ${op} response`
}

function decodes(schema: Schema.Decoder<unknown>, value: unknown) {
  return Exit.isSuccess(Schema.decodeUnknownExit(schema)(value))
}

/** Every expected field matches; `"$any"` matches any present value; arrays match element by element. */
export function subset(expected: unknown, actual: unknown): boolean {
  if (expected === "$any") return actual !== undefined
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => subset(item, actual[index]))
    )
  if (isRecord(expected))
    return isRecord(actual) && Object.entries(expected).every(([key, value]) => subset(value, actual[key]))
  return Object.is(expected, actual)
}

function describe(result: Received | { kind: "message"; message: unknown } | undefined) {
  if (!result) return "nothing"
  if (result.kind === "exit") return `exit ${result.code}`
  if (result.kind === "message")
    return result.message === undefined ? "a frame that is not JSON" : JSON.stringify(result.message)
  return `a ${result.bytes.length}-byte frame`
}

// A frame without an id; `check` has already decoded it as a `HelperEvent` when it has no problem.
function isEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !("id" in value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOp(value: string): value is Computer.HelperOpName {
  return Object.hasOwn(Computer.HelperOps, value)
}
