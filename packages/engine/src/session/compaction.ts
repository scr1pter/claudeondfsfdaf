import { isFreeModel } from "@vectordevai/schema/free-model"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { buildPrompt } from "@vectordevai/core/session/compaction"
import { SessionCompactionEvent } from "@vectordevai/schema/session-compaction-event"
import { SessionCodiumAuto } from "./codium-auto"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const CLEAR_TRIGGER = 60_000
const CLEAR_PROTECT = 20_000
const CLEAR_MINIMUM = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
// Outputs that cannot be fetched again: a skill's instructions, the user's answers and a subagent's report.
const PRUNE_PROTECTED_TOOLS = ["skill", "question", "task"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

type ImageSize = { width: number; height: number }

/** Preflight estimate: image pixels consume visual tokens, not the text tokens of their base64 transport. */
export const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
  messages: SessionV1.WithParts[]
  model: Provider.Model
}) {
  const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
  const hints = new Map<string, ImageSize>()
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "computer" || part.state.status !== "completed") continue
      const frame = part.state.metadata.frame
      if (typeof frame !== "object" || frame === null || !("width" in frame) || !("height" in frame)) continue
      if (typeof frame.width !== "number" || typeof frame.height !== "number" || !validSize(frame.width, frame.height))
        continue
      for (const image of part.state.attachments ?? []) {
        if (!image.mime.startsWith("image/")) continue
        const size = { width: frame.width, height: frame.height }
        hints.set(image.url, size)
        if (image.url.startsWith("data:")) hints.set(image.url.slice(image.url.indexOf(",") + 1), size)
      }
    }
  }
  const images: number[] = []
  const withoutImage = (part: unknown) => {
    if (typeof part !== "object" || part === null || !("type" in part)) return part
    if (part.type !== "image" && part.type !== "file" && part.type !== "media") return part
    if (
      part.type !== "image" &&
      (!("mediaType" in part) || typeof part.mediaType !== "string" || !part.mediaType.startsWith("image/"))
    )
      return part
    const data = "image" in part ? part.image : "data" in part ? part.data : undefined
    images.push(imageTokens(input.model, imageSize(data) ?? (typeof data === "string" ? hints.get(data) : undefined)))
    return "image" in part ? { ...part, image: "[image]" } : { ...part, data: "[image]" }
  }
  const text = msgs.map((message) =>
    typeof message.content === "string"
      ? message
      : {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== "tool-result" || part.output.type !== "content") return withoutImage(part)
            return { ...part, output: { ...part.output, value: part.output.value.map(withoutImage) } }
          }),
        },
  )
  return Token.estimate(JSON.stringify(text)) + images.reduce((total, tokens) => total + tokens, 0)
})

// These are preflight visual-token estimates; exact usage is reported by the provider after the request.
// Unknown dimensions use the ordinary attachment limit, without fetching remote media or decoding image pixels.
function imageTokens(model: Provider.Model, size: ImageSize = { width: 2000, height: 2000 }) {
  const id = model.api.id.toLowerCase()
  const npm = model.api.npm.toLowerCase()
  if (npm.includes("anthropic") || id.includes("claude")) {
    const scale = Math.min(
      1,
      1568 / Math.max(size.width, size.height),
      Math.sqrt(1_150_000 / (size.width * size.height)),
    )
    return Math.max(1, Math.ceil((size.width * size.height * scale * scale) / 750))
  }
  if (npm.includes("google") || id.includes("gemini")) {
    if (size.width <= 384 && size.height <= 384) return 258
    // Media resolution is provider-controlled; extreme saved headers must not dominate tail selection.
    return Math.min(8192, 258 * Math.ceil(size.width / 768) * Math.ceil(size.height / 768))
  }
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure" || /^(?:gpt-|o[1-9]|computer-use)/.test(id)) {
    if (/^(?:gpt-4\.1-(?:mini|nano)|o4-mini)/.test(id)) {
      const scale = Math.min(1, Math.sqrt((1536 * 32 * 32) / (size.width * size.height)))
      const patches = Math.min(1536, Math.ceil((size.width * scale) / 32) * Math.ceil((size.height * scale) / 32))
      return Math.ceil(patches * (id.startsWith("gpt-4.1-nano") ? 2.46 : id.startsWith("o4-mini") ? 1.72 : 1.62))
    }
    const scale = Math.min(1, 2048 / Math.max(size.width, size.height), 768 / Math.min(size.width, size.height))
    const tiles = Math.ceil((size.width * scale) / 512) * Math.ceil((size.height * scale) / 512)
    const base = id.includes("gpt-4o-mini")
      ? 2833
      : id.startsWith("computer-use")
        ? 65
        : id.startsWith("gpt-5")
          ? 70
          : /^o[13]/.test(id)
            ? 75
            : 85
    const tile = id.includes("gpt-4o-mini")
      ? 5667
      : id.startsWith("computer-use")
        ? 129
        : id.startsWith("gpt-5")
          ? 140
          : /^o[13]/.test(id)
            ? 150
            : 170
    return base + tile * tiles
  }
  return Math.min(8192, Math.max(256, Math.ceil((size.width * size.height) / 750)))
}

function validSize(width: number, height: number) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 1_000_000 &&
    height <= 1_000_000
  )
}

/** Reads only a bounded header; malformed or unsupported formats fall back to saved metadata or the default estimate. */
function imageSize(data: unknown): ImageSize | undefined {
  const header =
    typeof data === "string"
      ? /^https?:/i.test(data)
        ? undefined
        : Buffer.from((data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data).slice(0, 87_384), "base64")
      : data instanceof Uint8Array
        ? Buffer.from(data.subarray(0, 65_536))
        : undefined
  if (!header || header.length < 10) return
  const sized = (width: number, height: number) => (validSize(width, height) ? { width, height } : undefined)
  if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return sized(header.readUInt32BE(16), header.readUInt32BE(20))
  if (header.toString("ascii", 0, 6) === "GIF87a" || header.toString("ascii", 0, 6) === "GIF89a")
    return sized(header.readUInt16LE(6), header.readUInt16LE(8))
  if (header.length >= 30 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") {
    if (header.toString("ascii", 12, 16) === "VP8X")
      return sized(header.readUIntLE(24, 3) + 1, header.readUIntLE(27, 3) + 1)
    if (header.toString("ascii", 12, 16) === "VP8 " && header[23] === 0x9d && header[24] === 1 && header[25] === 0x2a)
      return sized(header.readUInt16LE(26) & 0x3fff, header.readUInt16LE(28) & 0x3fff)
    if (header.toString("ascii", 12, 16) === "VP8L" && header[20] === 0x2f) {
      const bits = header.readUInt32LE(21)
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
  }
  if (header[0] !== 0xff || header[1] !== 0xd8) return
  for (let at = 2; at + 3 < header.length; ) {
    if (header[at] !== 0xff) return
    while (at < header.length && header[at] === 0xff) at++
    const marker = header[at++]
    if (marker === 0xda || marker === 0xd9 || at + 2 > header.length) return
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = header.readUInt16BE(at)
    if (length < 2 || at + length > header.length) return
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7)
      return sized(header.readUInt16BE(at + 5), header.readUInt16BE(at + 3))
    at += length
  }
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

export function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    const first = input.turn.start + 1
    if (
      (yield* input.estimate({ messages: input.messages.slice(first, input.turn.end), model: input.model })) <=
      input.budget
    )
      return { start: first, id: input.messages[first]!.info.id } satisfies Tail
    // Conversion emits independent blocks per original message. Removing a prefix cannot grow the
    // estimate, so find the earliest fitting suffix without repeatedly converting every overlapping suffix.
    let start = first + 1
    let end = input.turn.end
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      const size = yield* input.estimate({
        messages: input.messages.slice(middle, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) {
        start = middle + 1
        continue
      }
      end = middle
    }
    if (start === input.turn.end) return undefined
    return { start, id: input.messages[start]!.info.id } satisfies Tail
  })
}

/**
 * The recent turns a summary keeps word for word, within the preserve budget. With a `floor` (a fork's first own
 * message) the kept tail starts at or after it: the history before it is the parent's, which the fork's own messages
 * cannot point back to.
 */
export const select = Effect.fn("SessionCompaction.select")(function* (input: {
  messages: SessionV1.WithParts[]
  cfg: ConfigV1.Info
  model: Provider.Model
  floor?: MessageID
}) {
  const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
  if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
  const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
  const floor = input.floor
  const all = turns(input.messages).filter((turn) => floor === undefined || turn.id >= floor)
  if (!all.length) return { head: input.messages, tail_start_id: undefined }
  const recent = all.slice(-limit)
  const sizes = yield* Effect.forEach(
    recent,
    (turn) =>
      estimate({
        messages: input.messages.slice(turn.start, turn.end),
        model: input.model,
      }),
    { concurrency: 1 },
  )

  let total = 0
  let keep: Tail | undefined
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!
    const size = sizes[i]
    if (total + size <= budget) {
      total += size
      keep = { start: turn.start, id: turn.id }
      continue
    }
    const remaining = budget - total
    const split = yield* splitTurn({
      messages: input.messages,
      turn,
      model: input.model,
      budget: remaining,
      estimate,
    })
    if (split) keep = split
    else if (!keep) {
      yield* Effect.logInfo("tail fallback", { budget, size, total })
    }
    break
  }

  if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
  return {
    head: input.messages.slice(0, keep.start),
    tail_start_id: keep.id,
  }
})

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  /** With compaction.clear on, clears old tool output inside a long run; true when it cleared some. */
  readonly clear: (input: { sessionID: SessionID; tokens: SessionV1.Assistant["tokens"] }) => Effect.Effect<boolean>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    /** What the summary must keep besides the conversation, such as a research run's digest. */
    context?: readonly string[]
    /** A fork's first own message: the kept tail and an overflow's replayed message come from it or after it. */
    floor?: MessageID
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    /** What the person chose when `model` is the one Codium Auto picked for the message (its `selected`). */
    selected?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    // The model Codium Auto picks for a summary: standard work over the history it summarises (`visible`, after the
    // last compaction boundary). When Auto cannot run, the session gets the notice a turn would and nothing is sent.
    const autoSummary = Effect.fnUntraced(function* (sessionID: SessionID, visible: readonly SessionV1.WithParts[]) {
      return yield* provider
        .codiumAuto({ tier: "standard", contextTokens: SessionCodiumAuto.contextTokens(visible) })
        .pipe(
          Effect.tapError((err) =>
            events.publish(Session.Event.Error, { sessionID, error: SessionCodiumAuto.notice(err) }),
          ),
          Effect.orDie,
        )
    })

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space.
    // Clearing changes the history, so the provider writes it to its cache again. That costs nothing extra only once
    // the cache has expired, when the whole history is re-sent at the cache-write price anyway, so it runs only then.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.prune === false) return

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return
      const last = msgs.findLast((msg) => msg.info.role === "assistant" && msg.info.time.completed)?.info
      if (last?.role !== "assistant" || !last.time.completed) return
      const model = yield* provider
        .getModel(last.providerID, last.modelID)
        .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (Date.now() - last.time.completed <= (model ? ProviderTransform.cacheLifetime(model) : 60 * 60_000)) return
      yield* Effect.logInfo("pruning")

      const found = clearable(msgs, { keepTurns: 2, protect: PRUNE_PROTECT })
      yield* Effect.logInfo("found", { pruned: found.tokens })
      if (found.tokens > PRUNE_MINIMUM) yield* markCleared(found.parts)
    })

    // Inside a long run the history only grows until compaction. Clearing rewrites the cached history after the first
    // cleared output, so it waits until enough can go to pay for that rewrite.
    const clear = Effect.fn("SessionCompaction.clear")(function* (input: {
      sessionID: SessionID
      tokens: SessionV1.Assistant["tokens"]
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.clear !== true) return false
      const used =
        input.tokens.total ||
        input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
      if (used < CLEAR_TRIGGER) return false
      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return false
      // The newest reply's tool results go to the model for the first time in the request about to be built.
      const unseen = msgs.findLast((msg) => msg.info.role === "assistant")?.info.id
      const found = clearable(msgs, { keepTurns: 0, protect: CLEAR_PROTECT, skip: unseen })
      if (found.tokens < CLEAR_MINIMUM) return false
      yield* markCleared(found.parts)
      return true
    })

    const markCleared = Effect.fn("SessionCompaction.markCleared")(function* (parts: SessionV1.ToolPart[]) {
      for (const part of parts) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          yield* session.updatePart(part)
        }
      }
      yield* Effect.logInfo("pruned", { count: parts.length })
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      context?: readonly string[]
      floor?: MessageID
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (input.floor !== undefined && msg.info.id < input.floor) break
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const primary = yield* provider
        .getModel(userMessage.model.providerID, userMessage.model.modelID)
        .pipe(Effect.orDie)
      // Codium Auto as the compaction agent's own model is a listing entry the gateway never serves: the summary runs
      // on the model Auto picks for it, whichever provider the session is on.
      const own =
        isFreeModel(primary) || !agent.model
          ? undefined
          : SessionCodiumAuto.isAuto(agent.model)
            ? yield* autoSummary(input.sessionID, input.messages)
            : agent.model
      const model = own ? yield* provider.getModel(own.providerID, own.modelID).pipe(Effect.orDie) : primary
      // A summary gains little from the high reasoning budget a session may run at, so compaction stops at medium.
      const variant =
        ["high", "xhigh", "max"].includes(userMessage.model.variant ?? "") && model.variants?.medium
          ? "medium"
          : userMessage.model.variant
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
        floor: input.floor,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      // The caller's context (a research run's digest) goes with a plugin's own prompt too.
      const nextPrompt = compacting.prompt
        ? [compacting.prompt, ...(input.context ?? [])].join("\n\n")
        : buildPrompt({ previousSummary, context: [...compacting.context, ...(input.context ?? [])] })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: { ...userMessage, model: { ...userMessage.model, variant } },
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        // The summary replaces this history, so nothing reads its prefix back from the cache.
        cache: false,
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            ...(original.selected ? { selected: original.selected } : {}),
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
              ...(userMessage.selected ? { selected: userMessage.selected } : {}),
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      selected?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      // A summary for a session on Codium Auto runs on the model Auto picks for it; the session stays on Auto. An
      // automatic compaction hands over the model Auto already picked for the message, with Auto as `selected`: the
      // summary and the continue message after it stay on that pick, and the session stays on Auto.
      const auto = SessionCodiumAuto.isAuto(input.model)
      const selected = auto ? { providerID: input.model.providerID, modelID: input.model.modelID } : input.selected
      const model = auto
        ? yield* autoSummary(
            input.sessionID,
            MessageV2.filterCompacted(
              (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).toReversed(),
            ),
          )
        : input.model
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        // Not rebuilt: the loop hands over the last user message's model with its variant.
        model,
        ...(selected ? { selected } : {}),
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      clear,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

// Walks back from the newest message, skipping the newest `keepTurns` user turns and the newest `protect` tokens of
// tool output, and collects the older completed tool outputs that are still in the history.
function clearable(msgs: SessionV1.WithParts[], input: { keepTurns: number; protect: number; skip?: string }) {
  const parts: SessionV1.ToolPart[] = []
  let total = 0
  let tokens = 0
  let turns = 0
  loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = msgs[msgIndex]
    if (msg.info.role === "user") turns++
    if (turns < input.keepTurns) continue
    if (msg.info.role === "assistant" && msg.info.summary) break loop
    if (msg.info.id === input.skip) continue
    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
      if (part.state.time.compacted) break loop
      const estimate = Token.estimate(part.state.output)
      total += estimate
      if (total <= input.protect) continue
      tokens += estimate
      parts.push(part)
    }
  }
  return { parts, tokens }
}

export * as SessionCompaction from "./compaction"
