export * as TaskStructured from "./task-structured"

import { createHash } from "node:crypto"
import { Deferred, Effect } from "effect"
import { JsonSchemaCheck } from "@vectordevai/core/json-schema-check"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { ModelV2 } from "@vectordevai/core/model"
import type { ProviderV2 } from "@vectordevai/core/provider"
import { BackgroundJob } from "@/background/job"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, type SessionID } from "@/session/schema"
import { SubagentLifecycle } from "./subagent-lifecycle"
import type { Truncate } from "./truncate"
import type { TaskPromptOps } from "./task"

// A subagent whose final answer must match a JSON Schema (multi-agent contract 5.E.2). A fresh child answers through
// StructuredOutput, whose invalid calls are retried inside the child's own run. This module handles only a run that
// ended without a value, by prompting the same child again, and decides how a value reaches the parent: whole, or as
// the file that holds it, never cut.

/** Invalid StructuredOutput calls a fresh child's run answers with an error before it keeps a value (retryCount). */
export const RETRIES = 2
/** The largest value, in UTF-8 bytes of its JSON, a parent reads inline; a larger one is saved and named. */
export const INLINE = 8 * 1024
/** Prompts after a run that ended with no value: a child answering through the tool has already retried in its run. */
const FOLLOW_UPS = { tool: 1, text: 2 } as const
const TOOL = "StructuredOutput"

export type Mode = "tool" | "text"
/** What the child's record keeps of a brief's output_schema. */
export type Accepted = { schema: Record<string, unknown>; schemaHash: string }
/** How a value reaches the parent: its JSON whole, or the file holding it. */
export type Shown = { readonly json: string } | { readonly ref: string }

/** A brief's output_schema, checked at launch: the stored form, or why Vector cannot check it. */
export function accept(schema: unknown): { ok: true; value: Accepted } | { ok: false; reason: string } {
  const checked = JsonSchemaCheck.accept(schema, { object: true })
  if (!checked.ok) return checked
  return {
    ok: true,
    value: { schema: checked.schema, schemaHash: createHash("sha256").update(checked.normalized).digest("hex") },
  }
}

/** The format a fresh child's prompts carry, so its run offers StructuredOutput for this schema. */
export function format(schema: Record<string, unknown>) {
  return new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema, retryCount: RETRIES })
}

/** A value as the parent's result element. */
export function element(shown: Shown) {
  return "json" in shown
    ? `<task_result format="json">\n${shown.json}\n</task_result>`
    : `<task_result format="json" truncated="true" ref="${shown.ref}"/>`
}

/** `json` whole when it fits `limit`, else saved to a file the ref names. */
export const shown = Effect.fnUntraced(function* (truncate: Truncate.Interface, json: string, limit: number = INLINE) {
  if (Buffer.byteLength(json, "utf8") <= limit) return { json } as Shown
  return { ref: yield* truncate.write(json) } as Shown
})

function answer(result: SessionV1.WithParts) {
  return result.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored && part.text ? [part.text] : []))
    .join("\n\n")
}

/** The JSON a finished child's last answer holds: its StructuredOutput value, or a ```json block it wrote. */
export function latest(messages: readonly SessionV1.WithParts[]): string | undefined {
  const last = messages.findLast((message) => message.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return undefined
  if (last.info.structured !== undefined) return JsonSchemaCheck.encode(last.info.structured)
  const extracted = JsonSchemaCheck.extract(answer(last))
  return extracted.ok ? JsonSchemaCheck.encode(extracted.value) : undefined
}

export type SettleInput = {
  sessions: Session.Interface
  ops: TaskPromptOps
  sessionID: SessionID
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  variant?: string
  agent: string
  schema: Record<string, unknown>
  /** "tool" for a child answering through StructuredOutput, "text" for one writing a ```json block (a fork). */
  mode: Mode
  /** The request shape every follow-up keeps; a tool-mode child's is a json_schema format, `format(schema)` by default. */
  format?: SessionPrompt.PromptInput["format"]
  system?: string
  tools?: Record<string, boolean>
  executionMode?: "normal" | "fast"
  /** The run's opening message: its StructuredOutput calls are those after it. */
  since: MessageID
  /** What the run returned. */
  result: SessionV1.WithParts
  /** The record attempt the run belongs to; its outcome is written to `record.structured`. */
  attempt?: number
}

export type Settled = { json: string; attempts: number }

// The settle each child last ran: the attempt it belongs to, every answer it read, and its outcome. A run that joined a
// busy child's loop (a steer) returns that loop's answer, which the settle already running is checking, so it takes that
// settle's outcome instead of following the same answer up again.
type Settling = {
  attempt?: number
  seen: Set<string>
  done: Deferred.Deferred<Settled, BackgroundJob.RunFailed>
  finished: boolean
}
const settling = new Map<string, Settling>()
const KEPT = 256

/**
 * The run's checked value as compact JSON, after at most one follow-up for a tool-mode child (two for a text-mode one)
 * when it ended without a value. Attempts are every StructuredOutput call plus every follow-up; a text-mode child's
 * answers count as its calls. A stopped child stops here too, and a run that failed otherwise fails as it did. One settle
 * runs per child at a time: a run of the same attempt that ends on an answer it is checking, or while it runs, gets its
 * outcome.
 */
export const settle = Effect.fn("TaskStructured.settle")(function* (i: SettleInput) {
  const done = yield* Deferred.make<Settled, BackgroundJob.RunFailed>()
  // Nothing yields from here until the entry is in the map, so two runs ending together cannot both take it.
  const running = settling.get(i.sessionID)
  if (running && running.attempt === i.attempt && (!running.finished || running.seen.has(i.result.info.id)))
    return yield* Deferred.await(running.done)
  const entry: Settling = { attempt: i.attempt, seen: new Set([i.result.info.id]), done, finished: false }
  settling.delete(i.sessionID)
  settling.set(i.sessionID, entry)
  for (const [id, item] of settling) {
    if (settling.size <= KEPT) break
    if (item.finished) settling.delete(id)
  }
  return yield* check(i, entry).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        entry.finished = true
      }).pipe(Effect.andThen(Deferred.done(entry.done, exit))),
    ),
  )
})

const check = Effect.fnUntraced(function* (i: SettleInput, entry: Settling) {
  let result = i.result
  let followUps = 0
  const calls = Effect.gen(function* () {
    if (i.mode === "text") return followUps + 1
    const messages = yield* i.sessions
      .messages({ sessionID: i.sessionID })
      .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
    return messages
      .filter((message) => message.info.role === "assistant" && message.info.id >= i.since)
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === TOOL).length
  })
  const record = (attempts: number, valid?: boolean) =>
    SubagentLifecycle.modify(i.sessions, i.sessionID, (current) => {
      if (!current.structured || (i.attempt !== undefined && current.attempt !== i.attempt)) return { value: undefined }
      const { valid: _, ...kept } = current.structured
      return {
        patch: { structured: { ...kept, attempts, ...(valid === undefined ? {} : { valid }) } },
        value: undefined,
      }
    }).pipe(Effect.ignore)
  const attempts = Effect.map(calls, (count) => (i.mode === "text" ? count : count + followUps))

  while (true) {
    const text = answer(result)
    const info = result.info.role === "assistant" ? result.info : undefined
    const missed = info?.error?.name === "StructuredOutputError"
    const failed = missed ? undefined : SubagentLifecycle.failure(info?.error)
    if (failed?.status === "cancelled") {
      yield* record(yield* attempts)
      return yield* Effect.interrupt
    }
    if (failed) {
      yield* record(yield* attempts)
      return yield* new BackgroundJob.RunFailed({ message: failed.error ?? "Task failed", output: text })
    }
    const found =
      i.mode === "tool"
        ? info?.structured === undefined
          ? ({ ok: false, reason: "no StructuredOutput call carried it." } as const)
          : ({ ok: true, value: info.structured } as const)
        : JsonSchemaCheck.extract(text)
    const problems = found.ok ? JsonSchemaCheck.validate(i.schema, found.value) : []
    if (found.ok && problems.length === 0) {
      const count = yield* attempts
      yield* record(count, true)
      return { json: JsonSchemaCheck.encode(found.value), attempts: count } satisfies Settled
    }
    // A tool-mode value was kept invalid only after the run's own retries ran out, so it is not asked for again.
    const again = (i.mode === "text" || !found.ok) && followUps < FOLLOW_UPS[i.mode]
    if (!again) {
      const count = yield* attempts
      yield* record(count, false)
      return yield* new BackgroundJob.RunFailed({
        message: `Structured output did not match output_schema after ${count} attempt${count === 1 ? "" : "s"}`,
        output: text,
      })
    }
    followUps += 1
    const reason = found.ok ? JsonSchemaCheck.describe(problems) : found.reason
    result = yield* i.ops.prompt({
      sessionID: i.sessionID,
      messageID: MessageID.ascending(),
      agent: i.agent,
      model: i.model,
      ...(i.variant ? { variant: i.variant } : {}),
      ...(i.mode === "tool"
        ? { format: i.format?.type === "json_schema" ? i.format : format(i.schema) }
        : i.format
          ? { format: i.format }
          : {}),
      ...(i.system ? { system: i.system } : {}),
      ...(i.tools ? { tools: i.tools } : {}),
      ...(i.executionMode ? { executionMode: i.executionMode } : {}),
      parts: [
        {
          type: "text",
          synthetic: true,
          text: `Your final answer did not match the required JSON Schema: ${reason} ${
            i.mode === "tool"
              ? "Call StructuredOutput with your final answer as JSON that matches it."
              : "Answer again with only a ```json block that matches it."
          }`,
        },
      ],
    })
    entry.seen.add(result.info.id)
  }
})
