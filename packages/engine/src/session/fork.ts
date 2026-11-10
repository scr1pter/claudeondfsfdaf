export * as SessionFork from "./fork"

import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { JsonSchemaCheck } from "@vectordevai/core/json-schema-check"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { MessageTable } from "@vectordevai/core/session/sql"
import type { Brain } from "@vectordevai/core/brain/brain"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import type { Tool } from "ai"
import { eq } from "drizzle-orm"
import { Clock, Context, Deferred, Effect, Layer, type Duration } from "effect"
import type { SubagentRecord } from "@/agent/subagent-kind"
import { InstanceState } from "@/effect/instance-state"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { isFreeModelRef } from "@vectordevai/schema/free-model"
import { NotFoundError } from "@/storage/storage"
import { NativePatch } from "./llm/native-patch"
import type { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

// Forks (multi-agent contract 5.E.3): children that start from their parent's whole conversation and read its prompt
// cache. This holds what a forkable step sent (its prefix), whether the step that launched a fork finished, and the
// history a fork inherits; the pure rules for a fork's tools and first message are below the service.

export type Outcome = "ready" | "stopped"

/** What a step sent besides its messages, which a fork rebuilds from the database. */
export type Request = Pick<
  LLM.StreamInput,
  "user" | "agent" | "model" | "explore" | "effort" | "permission" | "stableSystem" | "system" | "tools" | "retries"
>

export type Prefix = {
  /** The step's assistant message: the fork point. */
  readonly messageID: MessageID
  /** The root session the step ran in. */
  readonly sessionID: SessionID
  readonly request: Request
  /** Whether the step's history carried the owner's personal memory, and for which audience. */
  readonly personal: boolean
  readonly audience: Brain.Audience
}

/** A prefix as kept: the instance directory and Vector Local state it was sent under, and when. */
export type Remembered = Prefix & { readonly directory: string; readonly egress: boolean; readonly at: number }

export type InheritInput = {
  readonly session: { readonly id: SessionID; readonly parentID?: SessionID }
  readonly record: Pick<SubagentRecord, "parentSessionID" | "fork">
  /** The fork's own history, as filterCompacted shows it. */
  readonly messages: readonly SessionV1.WithParts[]
  /** The step about to be sent. */
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly variant?: string
  readonly agent: string
  readonly personal: boolean
  readonly audience: Brain.Audience
  /** A guest has acted somewhere in the tree. */
  readonly guest: boolean
}

export type Inherited = {
  /** The parent's history before the fork point and the launching message, virtualized: a fresh copy every call. */
  readonly messages: SessionV1.WithParts[]
  /** Set when the fork's request may reuse the parent's (the warm path). */
  readonly prefix?: Remembered
}

export type UserFields = {
  readonly system?: string
  readonly tools?: Record<string, boolean>
  readonly executionMode?: SessionV1.User["executionMode"]
  readonly variant?: string
  readonly model: {
    readonly providerID: SessionV1.User["model"]["providerID"]
    readonly modelID: SessionV1.User["model"]["modelID"]
  }
}

export interface Interface {
  /** Keeps a forkable step's prefix before the step is sent. */
  readonly remember: (prefix: Prefix) => Effect.Effect<void>
  /** The processor's end of a step: its step-finish ("ready"), or an error or abort ("stopped"). The first call wins. */
  readonly stepFinished: (messageID: MessageID, reason: string) => Effect.Effect<void>
  /** Waits until the launching step finished; after a restart the database answers. `timeout` is for tests. */
  readonly ready: (i: {
    sessionID: SessionID
    messageID: MessageID
    timeout?: Duration.Input
  }) => Effect.Effect<Outcome>
  /** Keeps the prefix (and the inherited history) while `child` uses it; true when a prefix was found. */
  readonly hold: (messageID: MessageID, child: SessionID) => Effect.Effect<boolean>
  readonly release: (child: SessionID) => Effect.Effect<void>
  readonly prefix: (messageID: MessageID) => Effect.Effect<Remembered | undefined>
  /** The history a fork inherits, or undefined for a session that is not a fork or that has compacted since. */
  readonly inherited: (i: InheritInput) => Effect.Effect<Inherited | undefined>
  /** The request shape every prompt into a fork keeps: its first own message's, else its launching step's. */
  readonly userFields: (record: Pick<SubagentRecord, "fork" | "model">) => Effect.Effect<UserFields>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionFork") {}

/** Prefixes one instance keeps; past it the oldest unheld go first. */
export const LIMIT = 64
// A hold on a point with no prefix keeps only its inherited history, as long as the longest provider cache lives.
const LONGEST = 60 * 60_000
// Finished steps remembered for `ready`; steps still running are always kept.
const STEPS = 256

type Hold = { point: MessageID; used: number; lifetime: number }
type State = {
  readonly entries: Map<MessageID, Remembered>
  /** Each root session's newest prefix; an older one is replaced. */
  readonly latest: Map<SessionID, MessageID>
  readonly holds: Map<SessionID, Hold>
  /** Inherited histories, computed once per point so every sibling and every step sends the same bytes. */
  readonly windows: Map<MessageID, SessionV1.WithParts[]>
}
type Step = { readonly done: Deferred.Deferred<Outcome>; outcome?: Outcome }

const lifetime = (prefix: Remembered) => ProviderTransform.cacheLifetime(prefix.request.model)

// Drops lapsed holds, then prefixes that are unheld and replaced or past their cache lifetime, then the oldest past
// LIMIT (unheld first), then histories nothing keeps.
function sweep(st: State, now: number) {
  for (const [child, hold] of st.holds) if (now - hold.used > hold.lifetime) st.holds.delete(child)
  const held = new Set([...st.holds.values()].map((hold) => hold.point))
  for (const [point, entry] of st.entries) {
    if (held.has(point)) continue
    if (st.latest.get(entry.sessionID) !== point || now - entry.at > lifetime(entry)) st.entries.delete(point)
  }
  if (st.entries.size > LIMIT) {
    const order = [...st.entries.values()].toSorted(
      (a, b) => Number(held.has(a.messageID)) - Number(held.has(b.messageID)) || a.at - b.at,
    )
    for (const entry of order.slice(0, st.entries.size - LIMIT)) st.entries.delete(entry.messageID)
  }
  for (const [sessionID, point] of st.latest) if (!st.entries.has(point)) st.latest.delete(sessionID)
  for (const point of st.windows.keys()) if (!st.entries.has(point) && !held.has(point)) st.windows.delete(point)
}

const outcomeOf = (reason: string): Outcome => (reason === "error" || reason === "abort" ? "stopped" : "ready")

// When this process started: a step created before it that never finished died with an earlier engine.
const BOOT = performance.timeOrigin

const sameDirectory = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b

// A fork whose own summary replaced its history no longer needs the parent's: the summary covers it.
const compacted = (messages: readonly SessionV1.WithParts[]) =>
  messages.some((msg) => msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    // Steps are keyed by message ID, which is unique, so the processor reaches them from any instance.
    const steps = new Map<string, Step>()

    const step = (messageID: string) => {
      const existing = steps.get(messageID)
      if (existing) return existing
      const created: Step = { done: Deferred.makeUnsafe<Outcome>() }
      steps.set(messageID, created)
      if (steps.size > STEPS)
        for (const [id, item] of steps) {
          if (steps.size <= STEPS) break
          if (item.outcome) steps.delete(id)
        }
      return created
    }

    const settle = (item: Step, outcome: Outcome) => {
      if (item.outcome) return item.outcome
      item.outcome = outcome
      Deferred.doneUnsafe(item.done, Effect.succeed(outcome))
      return outcome
    }

    const state = yield* InstanceState.make<State>(() =>
      Effect.succeed({ entries: new Map(), latest: new Map(), holds: new Map(), windows: new Map() }),
    )

    const current = Effect.fnUntraced(function* () {
      const st = yield* InstanceState.get(state)
      sweep(st, yield* Clock.currentTimeMillis)
      return st
    })

    const remember: Interface["remember"] = Effect.fn("SessionFork.remember")(function* (prefix) {
      const st = yield* current()
      step(prefix.messageID)
      st.entries.set(prefix.messageID, {
        ...prefix,
        directory: yield* InstanceState.directory,
        egress: Egress.policy().enabled,
        at: yield* Clock.currentTimeMillis,
      })
      st.latest.set(prefix.sessionID, prefix.messageID)
      sweep(st, yield* Clock.currentTimeMillis)
    })

    const stepFinished: Interface["stepFinished"] = (messageID, reason) =>
      Effect.sync(() => {
        const item = steps.get(messageID)
        if (item) settle(item, outcomeOf(reason))
      })

    // What the database says about a launching step this process is not running.
    const recorded = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID) {
      const found = yield* MessageV2.get({ sessionID, messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
      )
      const info = found?.info
      if (!info || info.role !== "assistant" || info.error) return "stopped" as const
      if (info.finish) return outcomeOf(info.finish)
      if (info.time.completed || info.time.created < BOOT) return "stopped" as const
      return undefined
    })

    const ready: Interface["ready"] = Effect.fn("SessionFork.ready")(function* (i) {
      const known = steps.get(i.messageID)
      if (known?.outcome) return known.outcome
      // Registered before the database is read, so a step that finishes in between still settles it.
      const item = known ?? step(i.messageID)
      if (!known) {
        const outcome = yield* recorded(i.sessionID, i.messageID)
        if (outcome) return settle(item, outcome)
      }
      const wait = Deferred.await(item.done)
      return yield* i.timeout === undefined
        ? wait
        : wait.pipe(Effect.timeoutOrElse({ duration: i.timeout, orElse: () => Effect.succeed("stopped" as const) }))
    })

    const hold: Interface["hold"] = Effect.fn("SessionFork.hold")(function* (messageID, child) {
      const st = yield* current()
      const entry = st.entries.get(messageID)
      st.holds.set(child, {
        point: messageID,
        used: yield* Clock.currentTimeMillis,
        lifetime: entry ? lifetime(entry) : LONGEST,
      })
      return entry !== undefined
    })

    const release: Interface["release"] = Effect.fn("SessionFork.release")(function* (child) {
      const st = yield* InstanceState.get(state)
      st.holds.delete(child)
      sweep(st, yield* Clock.currentTimeMillis)
    })

    const prefix: Interface["prefix"] = Effect.fn("SessionFork.prefix")(function* (messageID) {
      return (yield* current()).entries.get(messageID)
    })

    const inherited: Interface["inherited"] = Effect.fn("SessionFork.inherited")(function* (i) {
      const fork = i.record.fork
      if (!fork?.from || i.session.parentID === undefined || i.session.parentID !== i.record.parentSessionID)
        return undefined
      if (!i.messages.some((msg) => msg.info.id === fork.from && msg.info.sessionID === i.session.id)) return undefined
      if (compacted(i.messages)) return undefined
      const st = yield* current()
      const now = yield* Clock.currentTimeMillis
      const point = fork.point as MessageID
      const parentID = i.session.parentID
      const window =
        st.windows.get(point) ??
        (yield* Effect.gen(function* () {
          const before = yield* MessageV2.filterCompactedBeforeEffect(parentID, point)
          const launching = yield* MessageV2.get({ sessionID: parentID, messageID: point }).pipe(
            Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
          )
          return [...before, ...(launching ? [virtualize(launching)] : [])]
        }).pipe(Effect.provideService(Database.Service, database)))
      // Kept while the prefix or a hold needs it (sweep drops it otherwise).
      st.windows.set(point, window)
      const held = st.holds.get(i.session.id)
      if (held?.point === point) held.used = now
      const entry = st.entries.get(point)
      const warm =
        entry !== undefined &&
        entry.request.model.providerID === i.model.providerID &&
        entry.request.model.id === i.model.modelID &&
        entry.request.user.model.variant === i.variant &&
        entry.request.agent.name === i.agent &&
        entry.personal === i.personal &&
        entry.audience === i.audience &&
        entry.egress === Egress.policy().enabled &&
        sameDirectory(entry.directory, yield* InstanceState.directory) &&
        !i.guest
      // A fresh copy every call: reminders are pushed into the messages a step sends, never into the kept history.
      return { messages: structuredClone(window), ...(warm ? { prefix: entry } : {}) }
    })

    const userFields: Interface["userFields"] = Effect.fn("SessionFork.userFields")(function* (record) {
      const read = (id: string | undefined) =>
        id
          ? db
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.id, id as MessageID))
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((row) => row?.data as SessionV1.Info | undefined),
              )
          : Effect.succeed(undefined)
      const own = yield* read(record.fork?.from)
      const point = own?.role === "user" ? undefined : yield* read(record.fork?.point)
      const user = own?.role === "user" ? own : point?.role === "assistant" ? yield* read(point.parentID) : undefined
      if (user?.role !== "user")
        return {
          ...(record.model.variant ? { variant: record.model.variant } : {}),
          model: {
            providerID: record.model.providerID as UserFields["model"]["providerID"],
            modelID: record.model.modelID as UserFields["model"]["modelID"],
          },
        }
      return {
        ...(user.system !== undefined ? { system: user.system } : {}),
        ...(user.tools ? { tools: user.tools } : {}),
        ...(user.executionMode ? { executionMode: user.executionMode } : {}),
        ...(user.model.variant ? { variant: user.model.variant } : {}),
        model: { providerID: user.model.providerID, modelID: user.model.modelID },
      }
    })

    return Service.of({ remember, stepFinished, ready, hold, release, prefix, inherited, userFields })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

// Pure rules -----------------------------------------------------------------------------------------------------------

/** Why no fork starts or resumes while the owner has turned forks off. */
export const TURNED_OFF = "Forks are turned off (sizing.subagents.fork); write a brief instead."
/** Why no fork starts or resumes for an agent the task permission's "fork" pattern denies. */
export const denied = (agent: string) =>
  `The task permission denies forks to the ${agent} agent; write a brief instead.`

/** Whether a model can carry forks: free and local ($0) models always, a paid one only where its provider caches. */
export function qualifies(model: Provider.Model) {
  const free = !model.cost.unpriced && model.cost.input === 0 && model.cost.output === 0
  return free || isFreeModelRef({ providerID: model.providerID, modelID: model.id }) || ProviderTransform.caches(model)
}

/** What every task call in the launching message returned, as a fork sees it. */
export const TASK_PLACEHOLDER = "Subagent started."
/** What every other local tool call in the launching message returned, as a fork sees it. */
export const OTHER_PLACEHOLDER = "Result not shown to forks."

/**
 * The launching message as a fork inherits it: no tokens, finished for its tool calls, and each local tool call's state
 * replaced by the same placeholder for every sibling. Its call ID, input and metadata (thought signatures among them)
 * stay, and so do parts the provider executed.
 */
export function virtualize(message: SessionV1.WithParts): SessionV1.WithParts {
  const info: SessionV1.Info =
    message.info.role === "assistant"
      ? {
          ...message.info,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "tool-calls",
        }
      : message.info
  return {
    info,
    parts: message.parts.map((part) =>
      part.type !== "tool" || part.metadata?.providerExecuted
        ? part
        : {
            ...part,
            state: {
              status: "completed" as const,
              input: part.state.input,
              output: part.tool === "task" ? TASK_PLACEHOLDER : OTHER_PLACEHOLDER,
              title: "",
              metadata: {},
              time: { start: 0, end: 0 },
            },
          },
    ),
  }
}

type ForkConfig = { readonly experimental?: { readonly primary_tools?: readonly string[] } }

// What a fork never runs: launching or asking anything (a fork launches nothing, I3), the owner's memory, the planning
// modes, the parent's StructuredOutput, and the tools the owner keeps for primary agents.
const NEVER = ["task", "workflow", "memory", "escalate", "research", "question", "plan_enter", "plan_exit"]

/** The tools a fork refuses, though their definitions stay so its requests match its parent's. */
export function REFUSED(cfg: ForkConfig): readonly string[] {
  return [...new Set([...NEVER, "StructuredOutput", ...(cfg.experimental?.primary_tools ?? [])])]
}

/** The fork session's own rules: it denies what REFUSED refuses, so an ask from inside a tool is refused too. */
export function FORK_DENIES(cfg: ForkConfig): PermissionV1.Ruleset {
  return REFUSED(cfg).map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
}

/** What a refused tool returns to the fork. */
export const refusal = (tool: string) => `${tool} is not available in a fork.`

/**
 * The fork's tools: each definition exactly as `tools` (the parent's prefix, or the parent's names when cold) has it,
 * run by the fork's own `own` tool; refused names, and names the fork has no tool for, refuse.
 */
export function adopt(input: {
  tools: Record<string, Tool>
  own: Record<string, Tool>
  refused: readonly string[]
}): Record<string, Tool> {
  const refused = new Set(input.refused)
  return Object.fromEntries(
    Object.entries(input.tools).map(([name, definition]) => {
      const own = refused.has(name) ? undefined : input.own[name]
      const tool: Tool = {
        ...definition,
        execute:
          own?.execute ??
          (() => {
            throw new Error(refusal(name))
          }),
      }
      if (own) NativePatch.carry(own, tool)
      return [name, tool]
    }),
  )
}

/** How a fork with a schema answers (TaskStructured text mode): in its directive, and in every later prompt. */
export function answerIn(schema: Record<string, unknown>) {
  return `End with only a \`\`\`json block whose value matches this JSON Schema: ${JsonSchemaCheck.encode(schema)}`
}

/**
 * The fork's first own message. Later prompts into it are plain follow-ups. With a schema it answers with a ```json
 * block (TaskStructured text mode).
 */
export function directive(i: { prompt: string; schema?: Record<string, unknown> }) {
  return [
    "<fork_assignment>",
    "You are a fork of the agent above, started to do only this. Do it yourself and end with your report to that agent; the user does not see it.",
    i.prompt.replace(/<(\/?)fork_assignment/g, "<\\$1fork_assignment"),
    ...(i.schema ? [answerIn(i.schema)] : []),
    "</fork_assignment>",
  ].join("\n")
}
