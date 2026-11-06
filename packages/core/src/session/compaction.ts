export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model, type Usage } from "@vectordevai/llm"
import { DateTime, Effect, Stream } from "effect"
import { Billing } from "@vectordevai/schema/billing"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import type { SpendGuard } from "../spend-guard"
import { SessionRunnerModel } from "./runner/model"
import { tokens as stepTokens } from "./runner/publish-llm-event"

const DEFAULT_BUFFER = 20_000
// Where sessions compact by default on 1M-class models, as in the V1 engine: every request re-sends the whole
// conversation, so a step at 900K costs several times one at 200K.
const DEFAULT_MAX_CONTEXT = 200_000
const LARGE_WINDOW = 500_000
// A ceiling under this would leave little more room than the fixed system prompt and tools take.
const MIN_MAX_CONTEXT = 64_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly maxContext?: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly guard: SpendGuard.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))
const requestSize = (request: LLMRequest) =>
  estimate({ system: request.system, messages: request.messages, tools: request.tools })

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      maxContext: current.max_context ?? result.maxContext,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      // The message the keep budget ends inside is cut there: its start is summarized and its end kept verbatim.
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0)
        return {
          head: [...conversation.slice(0, index), conversation[index].slice(0, -remaining)]
            .filter(Boolean)
            .join("\n\n"),
          recent: [conversation[index].slice(-remaining), ...conversation.slice(index + 1)]
            .filter(Boolean)
            .join("\n\n"),
        }
      break
    }
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split).join("\n\n"),
    recent: conversation.slice(split).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  // The request size at which a session's last summary attempt failed. Trying again on every turn would pay for a
  // full-history request each time, so the next attempt waits until the history has grown past it.
  const failures = new Map<SessionSchema.ID, number>()
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    if (yield* dependencies.guard.stopped(input.sessionID)) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const messageID = SessionMessage.ID.create()
        yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          reason: "auto",
        })
        const chunks: string[] = []
        let attempted = false
        let failed = false
        let usage: Usage | undefined
        const summarized = yield* restore(
          Effect.gen(function* () {
            // Started listeners may await while a linked session stops the root run.
            if (yield* dependencies.guard.stopped(input.sessionID)) return false
            return yield* Effect.suspend(() => {
              attempted = true
              return dependencies.llm
                .stream(
                  LLM.request({
                    model: input.model,
                    messages: [Message.user(summaryPrompt)],
                    tools: [],
                    generation: { maxTokens: summaryOutput },
                    // The summary replaces this history, so nothing would read a cache write of it back.
                    cache: "none",
                  }),
                )
                .pipe(
                  Stream.runForEach((event) => {
                    if (LLMEvent.is.providerError(event)) failed = true
                    if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
                    if (LLMEvent.is.stepFinish(event)) usage = event.usage
                    return Effect.void
                  }),
                  Effect.as(true),
                )
            })
          }),
        ).pipe(
          Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
          Effect.exit,
        )
        const summary = chunks.join("")
        const tokens = stepTokens(usage)
        const spend = SessionRunnerModel.spendStep(
          input.model,
          { tokens, providerMetadata: usage?.providerMetadata, incomplete: usage === undefined },
          { continues: true, patched: false },
        )
        const used = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
        // A Vector Codium summary is billed to the account's plan, so it is never priced here; the guard still counts
        // it as a Codium step through the spend's cost kind.
        const spent = !attempted
          ? {}
          : Billing.isCodium(input.model.provider)
            ? { cost: 0, unpriced: true, billing: "codium" as const, tokens }
            : {
                cost: spend.costUsd ?? 0,
                ...(usage === undefined || (spend.costUsd === undefined && used > 0) ? { unpriced: true } : {}),
                tokens,
              }
        const complete = summarized._tag === "Success" && summarized.value && !failed && summary.trim().length > 0
        if (complete) failures.delete(input.sessionID)
        if (!complete && attempted && summarized._tag === "Success")
          failures.set(input.sessionID, requestSize(input.request))
        const timestamp = yield* DateTime.now
        // Persist the terminal event before record's live spend notification. Attempt both settlements even if a
        // listener fails, and preserve the original stream cause after interruption or a defect.
        const published = yield* (
          complete
            ? dependencies.events
                .publish(SessionEvent.Compaction.Ended, {
                  sessionID: input.sessionID,
                  messageID,
                  timestamp,
                  reason: "auto",
                  text: summary,
                  recent: selected.recent,
                  ...spent,
                })
                .pipe(Effect.asVoid)
            : dependencies.events
                .publish(SessionEvent.Compaction.Failed, {
                  sessionID: input.sessionID,
                  messageID,
                  timestamp,
                  reason: "auto",
                  ...spent,
                })
                .pipe(Effect.asVoid)
        ).pipe(Effect.exit)
        // Replay projects the durable event; it never charges the process-global run a second time.
        const recorded = yield* (attempted ? dependencies.guard.record(input.sessionID, spend) : Effect.void).pipe(
          Effect.exit,
        )
        if (summarized._tag === "Failure") return yield* Effect.failCause(summarized.cause)
        if (published._tag === "Failure") return yield* Effect.failCause(published.cause)
        if (recorded._tag === "Failure") return yield* Effect.failCause(recorded.cause)
        return complete
      }),
    )
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const window = context - Math.max(output, config.buffer)
    // Past a long-context price tier every token costs more, and 1M-class windows get a default ceiling; a configured
    // max_context replaces both, and 0 keeps the whole window.
    const ceiling =
      config.maxContext === 0
        ? undefined
        : ((config.maxContext === undefined ? undefined : Math.max(config.maxContext, MIN_MAX_CONTEXT)) ??
          SessionRunnerModel.contextTier(input.model) ??
          (context >= LARGE_WINDOW ? DEFAULT_MAX_CONTEXT : undefined))
    const threshold = ceiling === undefined ? window : Math.min(window, ceiling - Math.min(output, config.buffer))
    const size = requestSize(input.request)
    if (size <= threshold) return false
    const failedAt = failures.get(input.sessionID)
    if (failedAt !== undefined && size < failedAt * 1.25) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
