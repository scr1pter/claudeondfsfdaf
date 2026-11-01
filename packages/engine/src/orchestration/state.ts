import { Effect, Result, Schema, SchemaIssue } from "effect"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { SessionID } from "@vectordevai/schema/session-id"
import { MessageID } from "@/session/schema"
import type { WorkflowRunner } from "./runner"
import { WorkflowMarkers } from "./constants"

export const LIMIT = {
  inlineBytes: 2 * 1024,
  storedBytes: 16 * 1024 * 1024,
  valueBytes: 16 * 1024 * 1024,
  hydratedBytes: 128 * 1024 * 1024,
  nodes: WorkflowMarkers.MAX_NODES,
  sessions: 1000,
  groups: 32,
  artifacts: 1056,
  valueDepth: 64,
  valueNodes: 100_000,
  storedDepth: 72,
  storedNodes: 2_000_000,
} as const
export const VERSION = 1
type Json = typeof Schema.Json.Type
const optional = Schema.optional
const integer = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const identifier = text(128).check(Schema.isMinLength(1), Schema.isPattern(/^[A-Za-z0-9_.:-]+$/))
const stage = text(65).check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}(?:\.[a-z][a-z0-9_-]{0,31})?$/))
const group = text(32).check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/))
const session = SessionID.check(Schema.isMaxLength(256), Schema.isPattern(/^ses[A-Za-z0-9_:-]+$/))
const message = MessageID.check(Schema.isMaxLength(256), Schema.isPattern(/^msg[A-Za-z0-9_:-]+$/))
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Counters = Schema.Struct({
  launched: integer,
  steps: integer,
  tokens: integer,
  spentUsd: amount,
  elapsedMs: amount,
})
const Usage = Schema.Struct({
  cost: amount,
  steps: integer,
  toolUses: integer,
  total: integer,
  tokens: Schema.Struct({
    input: integer,
    output: integer,
    reasoning: integer,
    cache: Schema.Struct({ read: integer, write: integer }),
  }),
  unpricedSteps: optional(integer),
  codiumSteps: optional(integer),
})
export const Reference = Schema.Struct({
  sessionID: session,
  messageID: message,
  structured: Schema.Boolean,
  digest,
  bytes: integer.check(Schema.isGreaterThan(LIMIT.inlineBytes), Schema.isLessThanOrEqualTo(LIMIT.valueBytes)),
})
export type Reference = typeof Reference.Type
const Value = Schema.Union([Schema.Struct({ inline: Schema.Json }), Schema.Struct({ ref: Reference })])
type Value = typeof Value.Type
const PendingResult = Schema.Struct({
  verifier: Schema.Boolean,
  round: integer,
  result: Schema.Struct({
    sessionID: optional(session),
    messageID: optional(message),
    retryable: optional(Schema.Boolean),
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    output: optional(Value),
    error: optional(text(16 * 1024)),
    usage: optional(Usage),
  }),
})
const Node = Schema.Struct({
  key: identifier,
  stage,
  phase: optional(text(40)),
  item: optional(identifier),
  itemKey: identifier,
  value: Schema.Null,
  index: integer,
  source: optional(text(16 * 1024)),
  status: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "skipped",
    "interrupted",
  ]),
  round: optional(integer),
  verified: optional(Schema.Boolean),
  error: optional(text(16 * 1024)),
  sessionID: optional(session),
  verifierID: optional(session),
  output: optional(Value),
  outputMessageID: optional(message),
  outputStructured: optional(Schema.Boolean),
  feedbackMessageID: optional(message),
  final: optional(Schema.Boolean),
  execution: optional(Schema.Literals(["producer", "verifier", "repair", "done"])),
  pendingLaunch: optional(Schema.Struct({ key: identifier, verifier: Schema.Boolean, round: integer })),
  pendingResult: optional(PendingResult),
  retriesDone: optional(integer),
  settledOrder: optional(integer),
  skippedReason: optional(Schema.Literals(["when", "verification", "limit"])),
  feedback: optional(Value),
})
export const Stored = Schema.Struct({
  version: Schema.Literal(VERSION),
  nodes: Schema.Array(Node).check(Schema.isMaxLength(LIMIT.nodes)),
  usage: Counters,
  groups: Schema.Record(group, Counters).check(Schema.isMaxProperties(LIMIT.groups)),
  sessions: Schema.Record(session, Usage).check(Schema.isMaxProperties(LIMIT.sessions)),
  sessionGroups: optional(Schema.Record(session, group).check(Schema.isMaxProperties(LIMIT.sessions))),
  uncertain: optional(Schema.Boolean),
  clock: optional(
    Schema.Struct({
      at: amount,
      active: Schema.Boolean,
      groups: Schema.Array(group).check(Schema.isMaxLength(LIMIT.groups)),
    }),
  ),
  files: optional(
    Schema.Record(stage, Schema.Struct({ digest, path: text(4096).check(Schema.isMinLength(1)) })).check(
      Schema.isMaxProperties(LIMIT.artifacts),
    ),
  ),
})
export type Stored = typeof Stored.Type

export class StateError extends Schema.TaggedErrorClass<StateError>()("WorkflowState.StateError", {
  code: Schema.Literals(["shape", "version", "bound", "reference", "integrity"]),
  path: Schema.String,
  message: Schema.String,
  cause: optional(Schema.Defect()),
}) {}
export type Read = (
  reference: Pick<Reference, "sessionID" | "messageID" | "structured">,
) => Effect.Effect<Json, unknown>

/** Item values regenerate from the validated sources; result values keep immutable provenance. */
export const encode = Effect.fn("WorkflowState.encode")(function* (state: WorkflowRunner.State) {
  return yield* Effect.try({
    try: () => {
      if (state.nodes.length > LIMIT.nodes) throw bound("/nodes", `Checkpoint exceeds ${LIMIT.nodes} workflow nodes.`)
      const nodes = state.nodes.map((node, index) => {
        const { value, output, feedback, pendingResult, ...metadata } = node
        const at = `/nodes/${index}`
        return {
          ...metadata,
          value: null,
          ...(output === undefined
            ? {}
            : {
                output: pack(
                  output,
                  { sessionID: node.sessionID, messageID: node.outputMessageID, structured: node.outputStructured },
                  `${at}/output`,
                ),
              }),
          ...(feedback === undefined
            ? {}
            : {
                feedback: pack(
                  feedback,
                  { sessionID: node.verifierID, messageID: node.feedbackMessageID, structured: true },
                  `${at}/feedback`,
                ),
              }),
          ...(pendingResult === undefined
            ? {}
            : {
                pendingResult: {
                  ...pendingResult,
                  result: {
                    ...pendingResult.result,
                    ...(pendingResult.result.output === undefined
                      ? {}
                      : {
                          output: pack(
                            pendingResult.result.output,
                            {
                              sessionID: pendingResult.result.sessionID,
                              messageID: pendingResult.result.messageID,
                              structured: pendingResult.verifier ? true : node.outputStructured,
                            },
                            `${at}/pendingResult/result/output`,
                          ),
                        }),
                  },
                },
              }),
        }
      })
      return checked({ ...state, version: VERSION, nodes }, true)
    },
    catch: (cause) => error(cause),
  })
})

/** Absent, malformed or unsupported stored state is an error, never an empty fresh run. */
export const decode = Effect.fn("WorkflowState.decode")(function* (value: unknown) {
  return yield* Effect.try({ try: () => checked(value, false), catch: (cause) => error(cause) })
})

export const hydrate = Effect.fn("WorkflowState.hydrate")(function* (value: unknown, options: { readonly read: Read }) {
  const stored = yield* decode(value)
  const refs = yield* Effect.try({ try: () => references(stored), catch: (cause) => error(cause) })
  const cache = new Map<string, Json>()
  for (const [key, reference] of refs) {
    const answer = yield* options
      .read({ sessionID: reference.sessionID, messageID: reference.messageID, structured: reference.structured })
      .pipe(
        Effect.mapError(
          (cause) =>
            new StateError({
              code: "reference",
              path: `/references/${reference.messageID}`,
              message: "The saved workflow answer could not be read; resume was refused.",
              cause,
            }),
        ),
      )
    yield* Effect.try({
      try: () => {
        const at = `/references/${reference.messageID}`
        const bytes = size(answer, at, valueBounds)
        if (bytes !== reference.bytes || WorkflowPlan.key(answer) !== reference.digest)
          throw new StateError({
            code: "integrity",
            path: at,
            message: "The saved workflow answer no longer matches its checkpoint digest and byte length.",
          })
        cache.set(key, answer)
      },
      catch: (cause) => error(cause),
    })
  }
  const unpack = (value: Value | undefined) =>
    value === undefined ? undefined : "inline" in value ? value.inline : cache.get(referenceKey(value.ref))!
  const { version, ...state } = stored
  const result: WorkflowRunner.State = {
    ...state,
    nodes: stored.nodes.map((node) => ({
      ...node,
      output: unpack(node.output),
      feedback: unpack(node.feedback),
      pendingResult: node.pendingResult && {
        ...node.pendingResult,
        result: { ...node.pendingResult.result, output: unpack(node.pendingResult.result.output) },
      },
    })),
  }
  return result
})

function pack(
  value: unknown,
  provenance: { sessionID?: SessionID; messageID?: MessageID; structured?: boolean },
  at: string,
): Value {
  const bytes = size(value, at, valueBounds)
  if (bytes <= LIMIT.inlineBytes) return { inline: value as Json }
  if (!provenance.sessionID || !provenance.messageID || typeof provenance.structured !== "boolean")
    throw new StateError({
      code: "reference",
      path: at,
      message: "A workflow value over 2 KiB requires its exact child session, assistant message and output kind.",
    })
  return {
    ref: {
      sessionID: provenance.sessionID,
      messageID: provenance.messageID,
      structured: provenance.structured,
      digest: WorkflowPlan.key(value),
      bytes,
    },
  }
}

function checked(input: unknown, omitUndefined: boolean): Stored {
  size(input, "", { bytes: LIMIT.storedBytes, depth: LIMIT.storedDepth, nodes: LIMIT.storedNodes }, omitUndefined)
  if (input && typeof input === "object" && Object.getOwnPropertyDescriptor(input, "version")?.value !== VERSION)
    throw new StateError({
      code: "version",
      path: "/version",
      message: "Unsupported or missing workflow checkpoint version.",
    })
  const parsed = Schema.decodeUnknownResult(Stored, { onExcessProperty: "error", errors: "first" })(input)
  if (Result.isFailure(parsed)) {
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues[0]
    const at =
      "/" + (issue?.path ?? []).map((part) => pointer(String(typeof part === "object" ? part.key : part))).join("/")
    throw new StateError({
      code: "shape",
      path: at,
      message: (issue?.message ?? "Malformed workflow checkpoint.").slice(0, 2048),
    })
  }
  const state = parsed.success
  const keys = new Set<string>()
  state.nodes.forEach((node, index) => {
    const at = `/nodes/${index}`
    if (keys.has(node.key))
      throw new StateError({ code: "shape", path: `${at}/key`, message: "Duplicate workflow node key." })
    keys.add(node.key)
    checkValue(
      node.output,
      { sessionID: node.sessionID, messageID: node.outputMessageID, structured: node.outputStructured },
      `${at}/output`,
    )
    checkValue(
      node.feedback,
      { sessionID: node.verifierID, messageID: node.feedbackMessageID, structured: true },
      `${at}/feedback`,
    )
    if (node.pendingResult)
      checkValue(
        node.pendingResult.result.output,
        {
          sessionID: node.pendingResult.result.sessionID,
          messageID: node.pendingResult.result.messageID,
          structured: node.pendingResult.verifier ? true : node.outputStructured,
        },
        `${at}/pendingResult/result/output`,
      )
  })
  for (const [session, group] of Object.entries(state.sessionGroups ?? {}))
    if (!Object.hasOwn(state.groups, group))
      throw new StateError({
        code: "shape",
        path: `/sessionGroups/${pointer(session)}`,
        message: "Session accounting references an unknown workflow group.",
      })
  const activeGroups = new Set<string>()
  for (const [index, group] of (state.clock?.groups ?? []).entries()) {
    if (activeGroups.has(group) || !Object.hasOwn(state.groups, group))
      throw new StateError({
        code: "shape",
        path: `/clock/groups/${index}`,
        message: "Workflow clock groups must be unique and name saved group counters.",
      })
    activeGroups.add(group)
  }
  // Apply the resume budget while encoding too: never persist a checkpoint that
  // the same codec would refuse to hydrate after an interruption.
  references(state)
  // Normalize optional undefined fields out of the object before persistence, after
  // validation. This also severs aliases to the mutable in-process checkpoint.
  return JSON.parse(JSON.stringify(state)) as Stored
}

function checkValue(
  value: Value | undefined,
  expected: { sessionID?: SessionID; messageID?: MessageID; structured?: boolean },
  at: string,
) {
  if (!value) return
  if ("inline" in value) {
    size(value.inline, at, { ...valueBounds, bytes: LIMIT.inlineBytes })
    return
  }
  if (
    value.ref.sessionID !== expected.sessionID ||
    value.ref.messageID !== expected.messageID ||
    value.ref.structured !== expected.structured
  )
    throw new StateError({
      code: "reference",
      path: at,
      message: "The workflow answer reference does not match its node's immutable provenance.",
    })
}

function values(node: Stored["nodes"][number]): Value[] {
  return [node.output, node.feedback, node.pendingResult?.result.output].filter(
    (value): value is Value => value !== undefined,
  )
}
function references(stored: Stored) {
  const refs = new Map<string, Reference>()
  let total = 0
  for (const node of stored.nodes)
    for (const value of values(node)) {
      if ("inline" in value) total += size(value.inline, "/inline", valueBounds)
      else {
        const key = referenceKey(value.ref)
        const known = refs.get(key)
        if (known && (known.digest !== value.ref.digest || known.bytes !== value.ref.bytes))
          throw new StateError({
            code: "integrity",
            path: "/nodes",
            message: "One immutable answer reference has conflicting digests or byte lengths.",
          })
        if (!known) {
          refs.set(key, value.ref)
          total += value.ref.bytes
        }
      }
      if (total > LIMIT.hydratedBytes)
        throw bound("/nodes", `Hydrated workflow payloads exceed ${LIMIT.hydratedBytes} bytes.`)
    }
  return refs
}
function referenceKey(reference: Reference) {
  return JSON.stringify([reference.sessionID, reference.messageID, reference.structured])
}
function pointer(value: string) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}
function bound(path: string, message: string) {
  return new StateError({ code: "bound", path, message })
}
function error(cause: unknown) {
  return cause instanceof StateError
    ? cause
    : new StateError({ code: "shape", path: "", message: "Malformed workflow checkpoint.", cause })
}
const valueBounds = { bytes: LIMIT.valueBytes, depth: LIMIT.valueDepth, nodes: LIMIT.valueNodes }

/** Count JSON bytes before schema traversal/stringification, without invoking accessors or toJSON. */
function size(
  value: unknown,
  path: string,
  limit: { bytes: number; depth: number; nodes: number },
  omitUndefined = false,
): number {
  const stack: { value: unknown; depth: number; path: string; leave?: boolean }[] = [{ value, depth: 0, path }]
  const active = new Set<object>()
  let bytes = 0
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()!
    const item = current.value
    if (current.leave) {
      active.delete(item as object)
      continue
    }
    if (++nodes > limit.nodes) throw bound(current.path, `Workflow JSON exceeds ${limit.nodes} values.`)
    if (current.depth > limit.depth) throw bound(current.path, `Workflow JSON exceeds depth ${limit.depth}.`)
    if (item === null) bytes += 4
    else if (typeof item === "string") bytes += stringBytes(item)
    else if (typeof item === "boolean") bytes += item ? 4 : 5
    else if (typeof item === "number" && Number.isFinite(item)) bytes += String(item).length
    else if (typeof item !== "object" || item === null)
      throw new StateError({
        code: "shape",
        path: current.path,
        message: "Workflow state must contain finite JSON data only.",
      })
    else {
      if (active.has(item))
        throw new StateError({ code: "shape", path: current.path, message: "Workflow state must not contain cycles." })
      if (
        (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) ||
        Object.getOwnPropertySymbols(item).length
      )
        throw new StateError({
          code: "shape",
          path: current.path,
          message: "Workflow state must contain plain JSON objects and arrays.",
        })
      if (Array.isArray(item) && item.length > limit.nodes)
        throw bound(current.path, `Workflow JSON exceeds ${limit.nodes} values.`)
      const keys = Object.keys(item)
      if (keys.length > limit.nodes) throw bound(current.path, `Workflow JSON exceeds ${limit.nodes} values.`)
      active.add(item)
      stack.push({ ...current, leave: true })
      let kept = 0
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!("value" in descriptor))
          throw new StateError({
            code: "shape",
            path: `${current.path}/${pointer(key)}`,
            message: "Workflow state cannot contain getters or setters.",
          })
        if (omitUndefined && descriptor.value === undefined && !Array.isArray(item)) continue
        if (Array.isArray(item) && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
          throw new StateError({
            code: "shape",
            path: current.path,
            message: "Workflow arrays cannot contain named properties.",
          })
        if (!Array.isArray(item)) bytes += stringBytes(key) + 1
        kept++
        stack.push({ value: descriptor.value, depth: current.depth + 1, path: `${current.path}/${pointer(key)}` })
      }
      if (Array.isArray(item) && kept !== item.length)
        throw new StateError({ code: "shape", path: current.path, message: "Workflow arrays cannot contain holes." })
      bytes += 2 + Math.max(0, kept - 1)
    }
    if (bytes > limit.bytes) throw bound(current.path, `Workflow JSON exceeds ${limit.bytes} bytes.`)
  }
  return bytes
}

function stringBytes(value: string) {
  // Count the JSON encoding directly, including escaped lone surrogates.
  let bytes = 2
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    else if (code === 34 || code === 92) bytes += 2
    else if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
    else bytes += 3
  }
  return bytes
}

export * as WorkflowState from "./state"
