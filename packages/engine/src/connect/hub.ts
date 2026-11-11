export * as ConnectHub from "./hub"

import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ConnectFindings } from "@vectordevai/core/connect/findings"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Connect } from "@vectordevai/schema/connect"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { WorkflowLibrary } from "@/orchestration/library"
import { Permission } from "@/permission"
import type { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Skill } from "@/skill"
import { DesktopTasks } from "@/task/desktop"
import { TaskNotify } from "@/task/notify"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
// Types only, as everywhere in connect: the hub must stay out of the prompt loop's module graph.
import type { SessionPrompt } from "@/session/prompt"
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import type { ConnectAdapter } from "./adapter"
import { ADAPTERS, DEPS as ADAPTER_DEPS } from "./adapters"
import { ConnectMembers } from "./members"
import { ConnectNote } from "./note"

// Connected tools' hub: one place where every hand-off starts, is checked, asks, runs, is recorded and ends.
//
// A hand-off starts from an agent's tool call, a workflow stage or a person, never from a member. Before anything is
// asked the hub checks, in order: the member and its action exist; every effect the member declared is one connect
// accepts (`read`, `write`) and the requester's own rules do not deny the permission it maps to; the member is ready
// (Vector Local included); for a review, the per-request cap and the requester's read rules over every file the
// reviewer could read (the repository from its top level, not only the folder the review starts in). Only then does
// it ask `connect` in the requester's session, and hand the work to the adapter with a context that asks the rest
// (`connect_model`, `connect_write`) and reports progress. The adapter reaches the prompt loop only through a helper
// handle that accepts the run's own hidden helper sessions, and only the vectorscope adapter gets one.
//
// Results persist with the session: the caller saves `metadata(run)` in the `connect` tool part, and `get`, `runs`,
// `since` and `fix` find a run there after a restart. Only a `connect` tool part in an assistant message counts: a
// client can write a synthetic text part with any metadata, so a note never carries a run. The in-memory ledger keeps
// the last 50 runs of each instance as a cache and holds what is running, so a run can be cancelled from anywhere. The
// hub itself makes no network call and no model call: only adapters do work, through the handle.
//
// A background run (CW-08) is a BackgroundJob of type `connect`, started only through `BackgroundJob.start`, so it
// lives in the instance's job registry and outlives the tool call: a settings reload waits for it, and deleting the
// session stops it. Its caller waits until the adapter's questions are behind it (`working`) or the run ends. A run
// that ended by then is the caller's to report; any other is written into its tool part when it ends, and reported
// once through TaskNotify as a `connect` note that names the run (ConnectNote). Its cap is worked out as outside the
// requester's run, since it may outlive the turn, and a run stopped on its budget starts none.

/** The most runs the in-memory ledger keeps per instance. Runs still going are never dropped. */
export const LEDGER_SIZE = 50
/** The key of a run in a tool part's or a note's metadata. */
export const METADATA_KEY = "connect"
/** The members that receive a helper handle. */
export const HELPER_MEMBERS: ReadonlySet<string> = new Set(["vectorscope"])
/** The agents each helper member's sessions may be prompted as, through the helper handle. */
export const HELPER_AGENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  vectorscope: new Set(["review", "security"]),
}
/**
 * The most files and directories the read check looks at before it refuses (fail closed). A link to a directory is
 * walked again under its own name only when a rule could tell the names apart, so a package store is walked once.
 */
export const MAX_SCAN = 2_000_000
/** What a run saved in a session reads as when it never ended there: Vector stopped while it was going. */
export const STOPPED_SUMMARY = "Vector stopped before this hand-off ended."
/** The BackgroundJob type of a background run. Its job id is the run id. */
export const JOB_TYPE = "connect"

/** What the caller of a hand-off supplies; the hub adds the run id and the request id. */
export type StartRequest =
  | Omit<Connect.ReviewRequest, "id" | "requestID">
  | Omit<Connect.FixRequest, "id" | "requestID">

/** What a tool call (or the owner service) lends the hub for one run. */
export interface Call {
  /**
   * The tool call's `ctx.ask`, so asks attach to the call. Without it the hub asks through Permission with the
   * requester's merged rules; a run with no session and no `ask` is refused at its first ask.
   */
  readonly ask?: Tool.Context["ask"]
  /** The tool call's `ctx.extra.promptOps`; the helper handle is built from them. */
  readonly promptOps?: TaskPromptOps
  /** The tool call's abort signal: the run is cancelled when it fires. */
  readonly abort?: AbortSignal
  /** Called each time the run changes; a tool streams it through `ctx.metadata`. */
  readonly update?: (run: Connect.Run) => Effect.Effect<void>
  /** What a write effect touches, such as a fix's owned paths, for the narrowing check. */
  readonly touches?: readonly string[]
  /** For a fix in an isolated worktree: starts the hidden connect_fix child through the task tool (CW-07). */
  readonly launch?: ConnectAdapter.Launcher
  /**
   * The tool call's message and call ids. A background run that outlives the call is written into that part when it
   * ends, and its note is dropped once that message is gone.
   */
  readonly part?: { readonly messageID: MessageID; readonly callID: string }
}

export interface StartInput {
  readonly request: StartRequest
  readonly call?: Call
}

export interface Interface {
  /**
   * Starts a hand-off and waits for it. It never fails: a refusal, a failure, a timeout or a cancel ends the run with
   * that result. A background run returns still running once its adapter's questions are behind it; it then reports
   * once, as a note to the requester's session, when it ends.
   */
  readonly run: (input: StartInput) => Effect.Effect<Connect.Run>
  /** Cancels a run that is going. With `sessionID`, only that session's own runs. False when there was none. */
  readonly cancel: (runID: string, scope?: { readonly sessionID?: SessionID }) => Effect.Effect<boolean>
  /** A run of this instance's ledger, else (with `sessionID`) the one saved in that session. */
  readonly get: (runID: string, sessionID?: SessionID) => Effect.Effect<Connect.Run | undefined>
  /** The ledger's runs, newest first; with `sessionID`, only the runs that session asked for. */
  readonly runs: (input?: { readonly sessionID?: SessionID }) => Effect.Effect<Connect.Run[]>
  /** The request a session is in (the message the user last wrote) and the review runs it already recorded. */
  readonly request: (sessionID: SessionID) => Effect.Effect<{ readonly requestID?: string; readonly reviews: number }>
  /**
   * Every workspace member. `tools` are `ToolRegistry.ids()`, which only the HTTP view passes, so the hub stays out of
   * a cycle with the registry. With `sessionID`, desktop work counts that session's tasks.
   */
  readonly members: (input?: {
    readonly tools?: readonly string[]
    readonly sessionID?: SessionID
  }) => Effect.Effect<Connect.Member[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ConnectHub") {}

/** The metadata a tool part or a connect note saves a run in. */
export function metadata(run: Connect.Run): Record<string, unknown> {
  return Option.match(encodeRun(run), { onNone: () => ({}), onSome: (encoded) => ({ [METADATA_KEY]: encoded }) })
}

/**
 * The run a stored part carries: only a `connect` tool part. A text part, synthetic or not, carries none, because a
 * client can write one with any metadata; a connect note only names its run. A run the schema does not accept is no
 * run.
 */
export function fromPart(part: SessionV1.Part): Connect.Run | undefined {
  if (part.type !== "tool" || part.tool !== "connect" || !("metadata" in part.state)) return undefined
  const raw = part.state.metadata?.[METADATA_KEY]
  if (raw === undefined) return undefined
  return Option.getOrUndefined(decodeRun(raw))
}

/** The runs a stored message carries: those in its `connect` tool parts, and only when the agent wrote it. */
export function fromMessage(message: SessionV1.WithParts): Connect.Run[] {
  if (message.info.role !== "assistant") return []
  return message.parts.flatMap((part) => fromPart(part) ?? [])
}

/**
 * A run as read back from a session. One that never ended there (its tool part was cut off by a stop, a crash or a
 * restart, and no ledger holds it) is not going any more: it reads as cancelled.
 */
export function settled(run: Connect.Run): Connect.Run {
  if (run.status === "done") return run
  const { progress: _, ...rest } = run
  return {
    ...rest,
    status: "done",
    result: {
      state: "cancelled",
      ...(run.request.action === "review" ? { verdict: "not-reviewed" as const, target: run.request.target } : {}),
      summary: STOPPED_SUMMARY,
      findings: [],
      sessions: [],
      notes: [],
    },
  }
}

/**
 * Whether a stored message is one the user wrote, rather than a note Vector wrote into the session. Text marked
 * ignored is not the user's words, as for the engine's own request sizing (`SessionTaskSize.real`).
 */
export function written(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "user") return false
  return message.parts.some((part) =>
    part.type === "text"
      ? !part.synthetic && !part.ignored
      : part.type === "file" || part.type === "agent" || part.type === "subtask",
  )
}

/** Whether a stored message is the marker of an automatic compaction after the context overflowed. */
export function overflowMarker(message: SessionV1.WithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "compaction" && part.auto && part.overflow === true)
  )
}

const decodeRun = Schema.decodeUnknownOption(Connect.Run)
const encodeRun = Schema.encodeOption(Connect.Run)
const decodeRequest = Schema.decodeUnknownEffect(Connect.Request)
const decodeResult = Schema.decodeUnknownOption(Connect.Result)
const decodeMember = Schema.decodeUnknownOption(Connect.Member)
const decodeConsent = Schema.decodeUnknownOption(Connect.Consent)

type Stop = "cancelled" | "timeout" | "caller"

interface Entry {
  run: Connect.Run
  readonly adapter?: ConnectAdapter.Adapter
  readonly call: Call
  /** The helper sessions the run prompted. */
  readonly sessions: Set<SessionID>
  /** Sessions connect made to place the run's helpers (CW-14); helpers may be their children. */
  readonly places: Set<SessionID>
  /** The requester's child sessions when the run was admitted: an earlier run's helpers, never this run's. */
  earlier?: ReadonlySet<SessionID>
  /** Consents already asked in this run. */
  readonly asked: Set<string>
  readonly controller: AbortController
  readonly done: Deferred.Deferred<Connect.Run>
  /** The adapter's questions are behind it and its long work begins (`working`). */
  readonly working: Deferred.Deferred<void>
  /** For a background run: whether its caller stopped waiting before it ended, so its end is owed as a note. */
  readonly owed: Deferred.Deferred<boolean>
  /** The caller stopped waiting: asks go to the requester's session, updates stop, and the end arrives as a note. */
  detached?: boolean
  fiber?: Fiber.Fiber<Connect.Result, Connect.Refusal>
  stop?: Stop
}

interface State {
  readonly runs: Map<string, Entry>
  /** `connect_model` patterns the user already answered in a request: "<requestID>\u0000<pattern>". */
  readonly models: Set<string>
}

interface Admission {
  readonly context: ConnectAdapter.HandoffContext
  readonly handle: NonNullable<ConnectAdapter.Adapter["handle"]>
}

const refusal = (code: Connect.RefusalCode, message: string) =>
  new Connect.Refusal({ code, message: clip(message, 2_000) })

const OFF = "Connected tools are off in this build (VECTOR_EXPERIMENTAL_CONNECT)."

/** The hub's layer over the given adapters. Tests pass fakes; the engine passes `ADAPTERS`. */
export const layerWith = <R>(factories: readonly ConnectAdapter.Factory<R>[]) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const agents = yield* Agent.Service
      const config = yield* Config.Service
      const events = yield* EventV2Bridge.Service
      const skills = yield* Skill.Service
      const mcp = yield* MCP.Service
      const library = yield* WorkflowLibrary.Service
      const desktop = yield* DesktopTasks.Service
      const background = yield* BackgroundJob.Service
      const notify = yield* TaskNotify.Service
      const database = yield* Database.Service
      // Where a background run's tool-part write runs: the hub's own scope, so nothing waits on it.
      const scope = yield* Scope.Scope
      const adapters = yield* Effect.all(factories)
      const byID = new Map(adapters.map((adapter) => [adapter.id, adapter]))

      const ledger = yield* InstanceState.make<State>(() =>
        Effect.succeed({ runs: new Map<string, Entry>(), models: new Set<string>() }),
      )

      // Never fails: a run must reach its end whatever a listener or the caller's update does.
      const publish = Effect.fnUntraced(function* (entry: Entry) {
        const sessionID = entry.run.request.requester.sessionID
        yield* events
          .publish(Connect.Event.RunUpdated, { ...(sessionID ? { sessionID } : {}), run: entry.run })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("connect.run.updated was not published", { cause })))
        // A caller that stopped waiting has nothing left to stream into.
        if (entry.call.update && !entry.detached)
          yield* entry.call.update(entry.run).pipe(Effect.catchCause(() => Effect.void))
      })

      // Runs recorded in a session since the user last wrote, newest first, read without loading the whole history.
      // An automatic compaction after the context overflowed copies the user's last message into a new one (the
      // replay, right after the compaction's marker and its summary); that copy is not the user writing again, so the
      // walk goes on to the message it copied, and the runs before the overflow still count in the request.
      const recorded = Effect.fnUntraced(function* (sessionID: SessionID) {
        const runs: Connect.Run[] = []
        let requestID: string | undefined
        // A message the user may have written, until the messages before it show whether it is a replay.
        let candidate: string | undefined
        let step: "summary" | "marker" = "summary"
        yield* sessions
          .findMessage(sessionID, (message) => {
            if (candidate !== undefined) {
              if (step === "summary" && message.info.role === "assistant" && message.info.summary === true) {
                step = "marker"
                return false
              }
              if (step === "marker" && overflowMarker(message)) {
                candidate = undefined
                return false
              }
              requestID = candidate
              return true
            }
            if (written(message)) {
              candidate = message.info.id
              step = "summary"
              return false
            }
            runs.push(...fromMessage(message))
            return false
          })
          .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
        return { requestID: requestID ?? candidate, runs }
      })

      // Runs saved in a session, newest first and each once, as `settled` reads them; at most `limit` of them.
      const stored = Effect.fnUntraced(function* (
        sessionID: SessionID,
        limit: number,
        match: (run: Connect.Run) => boolean = () => true,
      ) {
        const found = new Map<string, Connect.Run>()
        yield* sessions
          .findMessage(sessionID, (message) => {
            for (const run of fromMessage(message))
              if (!found.has(run.id) && match(run)) found.set(run.id, settled(run))
            return found.size >= limit
          })
          .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
        return [...found.values()].slice(0, limit)
      })

      const request: Interface["request"] = Effect.fn("ConnectHub.request")(function* (sessionID: SessionID) {
        const state = yield* InstanceState.get(ledger)
        const saved = yield* recorded(sessionID)
        return { requestID: saved.requestID, reviews: reviews(state, sessionID, saved.requestID, saved.runs) }
      })

      const get: Interface["get"] = Effect.fn("ConnectHub.get")(function* (runID: string, sessionID?: SessionID) {
        const state = yield* InstanceState.get(ledger)
        const entry = state.runs.get(runID)
        if (entry && (sessionID === undefined || entry.run.request.requester.sessionID === sessionID)) return entry.run
        if (!sessionID) return undefined
        const [found] = yield* stored(
          sessionID,
          1,
          (run) => run.id === runID && run.request.requester.sessionID === sessionID,
        )
        return found
      })

      // With a session, the runs it saved join the ledger's (the ledger wins on an id), so the list survives a
      // restart: the ledger is only a cache.
      const runs: Interface["runs"] = Effect.fn("ConnectHub.runs")(function* (input) {
        const state = yield* InstanceState.get(ledger)
        const sessionID = input?.sessionID
        const live = [...state.runs.values()]
          .map((entry) => entry.run)
          .filter((run) => sessionID === undefined || run.request.requester.sessionID === sessionID)
        const known = new Set(live.map((run) => run.id))
        const saved = sessionID
          ? (yield* stored(sessionID, LEDGER_SIZE)).filter(
              (run) => !known.has(run.id) && run.request.requester.sessionID === sessionID,
            )
          : []
        const all = [...live, ...saved].toSorted((a, b) => b.time.created - a.time.created || (a.id < b.id ? 1 : -1))
        return sessionID === undefined ? all : all.slice(0, LEDGER_SIZE)
      })

      const cancel: Interface["cancel"] = Effect.fn("ConnectHub.cancel")(function* (runID, scope) {
        const state = yield* InstanceState.get(ledger)
        const entry = state.runs.get(runID)
        if (!entry || entry.run.status === "done") return false
        if (scope?.sessionID !== undefined && entry.run.request.requester.sessionID !== scope.sessionID) return false
        yield* stopRun(entry, "cancelled")
        return true
      })

      // Before its work starts, a stopped run ends as soon as the work begins; after, its fiber is interrupted, and
      // the work records the run as cancelled on its way out.
      const stopRun = Effect.fnUntraced(function* (entry: Entry, stop: Stop) {
        entry.stop ??= stop
        entry.controller.abort()
        if (!entry.fiber) return
        yield* Fiber.interrupt(entry.fiber)
        yield* Deferred.await(entry.done)
      })

      // The requester's rules as a tool call of theirs would be checked: its agent's, then its session's.
      const rulesOf = Effect.fnUntraced(function* (requester: Connect.Requester, session?: Session.Info) {
        const name = requester.agent ?? (yield* agents.defaultAgent())
        const agent = yield* agents.get(name)
        if (!agent) return yield* refusal("not-allowed", `There is no agent named ${name}, so connect did not start.`)
        return Permission.merge(agent.permission, session?.permission ?? [])
      })

      const asker = (entry: Entry, sessionID: SessionID | undefined, rules: PermissionV1.Ruleset) =>
        Effect.fnUntraced(function* (consent: Connect.Consent) {
          const checked = Option.getOrUndefined(decodeConsent(consent))
          if (!checked)
            return yield* Effect.die(new Error("A connect adapter asked a consent connect does not accept."))
          // `connect_write` must reach the user every time. Only `requiresApproval` keeps a rule, a saved approval or a
          // client's auto-accept from answering it, so while it does not cover `connect_write` nothing is written.
          if (
            checked.permission === "connect_write" &&
            !PermissionPolicy.requiresApproval(checked.permission, [], checked.patterns)
          )
            return yield* refusal(
              "permission",
              "Connect writes only after asking you each time, and this build cannot yet keep a rule or a saved approval from answering that question, so connect did not write anything.",
            )
          const state = yield* InstanceState.get(ledger)
          const requestID = entry.run.request.requestID
          const key = `${checked.permission}\u0000${checked.patterns.join("\u0000")}`
          // `connect` is asked once per run, `connect_model` once per request for each model, `connect_write` always.
          if (checked.permission === "connect" && entry.asked.has(key)) return
          if (
            checked.permission === "connect_model" &&
            checked.patterns.every((pattern) => state.models.has(`${requestID}\u0000${pattern}`))
          )
            return
          const ask = {
            permission: checked.permission,
            patterns: [...checked.patterns],
            always: checked.permission === "connect_write" ? [] : [...checked.always],
            metadata: {
              description: checked.message,
              runID: entry.run.id,
              member: entry.run.request.to,
              ...(checked.model ? { model: checked.model } : {}),
              ...(checked.sendsTo ? { sendsTo: checked.sendsTo } : {}),
              ...(checked.maxCostUsd !== undefined ? { maxCostUsd: checked.maxCostUsd } : {}),
              ...(checked.findings ? { findings: [...checked.findings] } : {}),
              ...(checked.diff !== undefined ? { diff: checked.diff } : {}),
            },
          }
          // Once a background run's caller stopped waiting, its call is over: the requester's session is asked instead.
          const call = entry.detached ? undefined : entry.call.ask
          const exit = yield* (
            call
              ? call(ask)
              : sessionID
                ? permission.ask({ ...ask, sessionID, ruleset: rules })
                : Effect.fail(new PermissionV1.RejectedError())
          ).pipe(Effect.exit)
          if (Exit.isFailure(exit)) {
            const refused = refusalOf(exit.cause, checked, sessionID === undefined && !call)
            if (refused) return yield* refused
            if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
            return yield* Effect.die(Cause.squash(exit.cause))
          }
          entry.asked.add(key)
          if (checked.permission === "connect_model")
            for (const pattern of checked.patterns) approve(state, `${requestID}\u0000${pattern}`)
        })

      // Accepts only the run's own hidden helper sessions while the run is going (HelperHandle): made during this run
      // (not one of the requester's children from before it, such as an earlier run's helpers) and not held by another
      // run going now. A prompt keeps the member's fixed rules: it may not swap the session's tools, re-arm its
      // budget or skip its reply, and runs only as one of the member's own agents.
      const helperFor = (entry: Entry, ops: TaskPromptOps, member: string): ConnectAdapter.HelperHandle => {
        const requester = entry.run.request.requester.sessionID
        const refuse = (sessionID: SessionID, why: string) =>
          Effect.die(new Error(`Connect's helper handle refused session ${sessionID}: ${why}`))
        const admit = Effect.fnUntraced(function* (sessionID: SessionID) {
          if (entry.run.status !== "running") return yield* refuse(sessionID, "the run is not going")
          if (sessionID === requester) return yield* refuse(sessionID, "it is the requester's own session")
          const info = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
          if (!info) return yield* refuse(sessionID, "there is no such session")
          if (!info.internal?.startsWith(`${member}.`))
            return yield* refuse(sessionID, `it is not a hidden ${member} helper`)
          const parent = info.parentID
          if (!parent || (parent !== requester && !entry.places.has(parent)))
            return yield* refuse(sessionID, "its parent is not this run's requester")
          if (!entry.earlier || entry.earlier.has(sessionID))
            return yield* refuse(sessionID, "it was made before this run started")
          if (!entry.sessions.has(sessionID)) {
            const state = yield* InstanceState.get(ledger)
            for (const other of state.runs.values())
              if (other !== entry && other.run.status !== "done" && other.sessions.has(sessionID))
                return yield* refuse(sessionID, "another run going now holds it")
            if (entry.sessions.size >= Connect.MAX_SESSIONS)
              return yield* refuse(sessionID, `the run already made ${Connect.MAX_SESSIONS} helper sessions`)
          }
        })
        const agents = HELPER_AGENTS[member] ?? new Set<string>()
        const checkInput = (input: SessionPrompt.PromptInput) => {
          if (input.tools !== undefined) return refuse(input.sessionID, "a prompt may not change the session's tools")
          if (input.budget !== undefined) return refuse(input.sessionID, "a prompt may not set the session's budget")
          if (input.noReply !== undefined) return refuse(input.sessionID, "a prompt may not skip its reply")
          if (input.agent === undefined || !agents.has(input.agent))
            return refuse(input.sessionID, `it may be prompted only as ${[...agents].join(" or ") || "no agent"}`)
          return Effect.void
        }
        return {
          prompt: (input) =>
            Effect.gen(function* () {
              yield* checkInput(input)
              yield* admit(input.sessionID)
              entry.sessions.add(input.sessionID)
              return yield* ops.prompt(input)
            }),
          cancel: (sessionID) =>
            Effect.gen(function* () {
              yield* admit(sessionID)
              yield* ops.cancel(sessionID)
            }),
        }
      }

      // The caller's fix launcher, held to the run: it starts a child only while the run is going.
      const launcherFor =
        (entry: Entry, launch: ConnectAdapter.Launcher): ConnectAdapter.Launcher =>
        (input) =>
          entry.run.status === "running"
            ? launch(input)
            : Effect.die(new Error("Connect's fix launcher refused a start: the run is not going."))

      const spendOf = Effect.fnUntraced(function* (sessionID: SessionID | undefined) {
        if (!sessionID) return { running: false } satisfies ConnectPolicy.RunSpend
        const running = yield* guard.running(sessionID)
        const snapshot = yield* guard.snapshot(sessionID)
        const stopped = (yield* guard.stopped(sessionID)) ?? snapshot?.stopped
        return {
          running,
          ...(snapshot?.budget.usd !== undefined ? { limitUsd: snapshot.budget.usd } : {}),
          ...(snapshot ? { spentUsd: snapshot.spentUsd } : {}),
          ...(stopped ? { stopped: true } : {}),
        } satisfies ConnectPolicy.RunSpend
      })

      const admit = Effect.fnUntraced(function* (entry: Entry, saved: readonly Connect.Run[]) {
        const request = entry.run.request
        const requester = request.requester
        if (!flags.experimentalConnect) return yield* refusal("not-allowed", OFF)
        const session = requester.sessionID
          ? yield* sessions.get(requester.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        if (requester.sessionID && !session)
          return yield* refusal("not-allowed", "The session that asked no longer exists, so connect did not start.")
        // A member's own helper session never starts a hand-off (no chains).
        if (session?.internal)
          return yield* refusal("not-allowed", "A helper session cannot hand work to another member.")
        // Nor does a subagent (a child session the task tool made): only the conversation's own agent, a person or a
        // workflow stage hands work off.
        if (requester.kind === "agent" && session?.parentID)
          return yield* refusal("not-allowed", "A subagent cannot hand work to another member.")
        const adapter = entry.adapter
        if (!adapter) return yield* refusal("unknown", `Connect has no member named ${clip(request.to, 200)}.`)
        if (!adapter.handle)
          return yield* refusal("unknown", `${clip(request.to, 200)} is only listed; connect cannot hand work to it.`)
        const described = yield* adapter.describe().pipe(Effect.exit)
        if (Exit.isFailure(described))
          return yield* refusal("unavailable", `Connect could not check whether ${request.to} is ready.`)
        const member = described.value
        const action = (member.actions ?? []).find((item) => item.id === request.action)
        if (!action || member.id !== adapter.id)
          return yield* refusal("unknown", `${member.title || request.to} has no ${request.action} action.`)
        const rules = yield* rulesOf(requester, session)
        // The member's declared effects, checked as declared, before the schema and before any question.
        const narrowed = ConnectPolicy.narrowing({
          effects: action.effects,
          ruleset: rules,
          patterns: entry.call.touches,
        })
        if (!narrowed.ok) return yield* narrowed.refusal
        if (Option.isNone(decodeMember(member)))
          return yield* refusal("unavailable", `${request.to} described itself in a shape connect does not accept.`)
        // Only an action the member declares able to run in the background goes there, and it reports to a session
        // through the prompt calls its caller lent. A run stopped on its budget starts none, before any question.
        if (request.background) {
          if (!action.background)
            return yield* refusal(
              "input",
              `${member.title} cannot run ${request.action} in the background. Run it in the foreground.`,
            )
          if (!requester.sessionID || !entry.call.promptOps)
            return yield* refusal(
              "unavailable",
              "A background hand-off reports to its session as a note, and this one has no session to report to.",
            )
          if ((yield* spendOf(requester.sessionID)).stopped)
            return yield* refusal(
              "budget",
              "This run stopped on its budget, so connect did not start a background hand-off.",
            )
        }
        // Vector Local governs every member here as in the registry: one that runs in a cloud, or sends code past this
        // computer and the listed model servers, is off whatever it says of itself.
        const ready = ConnectMembers.gate(member, (yield* config.localPolicy()).enabled)
        if (ready.state !== "ready")
          return yield* refusal(
            "unavailable",
            `${member.title} is not ready${ready.reason ? `: ${ready.reason}` : "."}`,
          )
        const directory = yield* Effect.promise(() => isDirectory(request.directory))
        if (!path.isAbsolute(request.directory) || !directory)
          return yield* refusal("input", "The directory to work in does not exist.")
        if (request.action === "review") {
          const state = yield* InstanceState.get(ledger)
          const capped = ConnectPolicy.requestCap(
            reviews(state, requester.sessionID, request.requestID, saved, entry.run.id),
          )
          if (!capped.ok) return yield* capped.refusal
          yield* checkReads(request.directory, rules)
        }
        const previous = request.action === "review" && request.since ? yield* earlier(request, requester) : undefined
        const source = request.action === "fix" ? yield* fixSource(request, requester) : undefined
        // A fix writes the files of the findings it fixes, so the requester's rules are checked over those too.
        if (source?.result && request.action === "fix") {
          const chosen = new Set(request.findings)
          const touched = ConnectPolicy.fixTouches(source.result.findings.filter((item) => chosen.has(item.id)))
          const checked = ConnectPolicy.narrowing({ effects: action.effects, ruleset: rules, patterns: touched })
          if (!checked.ok) return yield* checked.refusal
        }
        const ask = asker(entry, requester.sessionID, rules)
        yield* ask({
          permission: "connect",
          patterns: [`${request.to}.${request.action}`],
          always: [`${request.to}.${request.action}`],
          message:
            request.action === "review"
              ? `Review your changes with ${member.title}.`
              : `Fix findings from ${request.run} with ${member.title}.`,
          ...(member.sendsTo ? { sendsTo: member.sendsTo } : {}),
        })
        const read = yield* spendOf(requester.sessionID)
        // A background run may outlive the turn that started it, so it is capped as a review outside the run: at what
        // the run has left (guard.snapshot), or $0.50 when it has no dollar limit.
        const spend: ConnectPolicy.RunSpend = request.background ? { ...read, running: false } : read
        // What the requester already had, so the helper handle reaches only the sessions this run makes.
        entry.earlier = new Set(
          requester.sessionID ? (yield* sessions.children(requester.sessionID)).map((child) => child.id) : [],
        )
        const remainingUsd =
          spend.limitUsd !== undefined ? Math.max(0, spend.limitUsd - (spend.spentUsd ?? 0)) : undefined
        const ops = entry.call.promptOps
        const context: ConnectAdapter.HandoffContext = {
          runID: entry.run.id,
          ...(requester.sessionID ? { sessionID: requester.sessionID } : {}),
          requestID: request.requestID,
          directory: request.directory,
          abort: entry.controller.signal,
          ask,
          progress: (update) => progress(entry, update),
          working: () => Deferred.succeed(entry.working, undefined).pipe(Effect.asVoid),
          ...(ops && HELPER_MEMBERS.has(adapter.id) ? { helper: helperFor(entry, ops, adapter.id) } : {}),
          ...(remainingUsd !== undefined ? { remainingUsd } : {}),
          spend,
          ...(previous ? { previous } : {}),
          ...(source ? { source } : {}),
          ...(request.action === "fix" && entry.call.launch && HELPER_MEMBERS.has(adapter.id)
            ? { launch: launcherFor(entry, entry.call.launch) }
            : {}),
        }
        return { context, handle: adapter.handle } satisfies Admission
      })

      const earlier = Effect.fnUntraced(function* (request: Connect.ReviewRequest, requester: Connect.Requester) {
        const since = request.since!
        const found = yield* get(since, requester.sessionID)
        // Only a review that did its work compares: a refused, failed or cancelled one has nothing to compare with.
        if (
          !found?.result ||
          found.request.action !== "review" ||
          (found.result.state !== "completed" && found.result.state !== "partial")
        )
          return yield* refusal("input", `There is no earlier review ${since} in this session to compare with.`)
        if (!ConnectFindings.comparable(found.result.target ?? found.request.target, request.target))
          return yield* refusal(
            "input",
            `${since} reviewed ${ConnectFindings.targetWords(found.request.target)}, so it cannot be compared with a review of ${ConnectFindings.targetWords(request.target)}.`,
          )
        return found
      })

      const fixSource = Effect.fnUntraced(function* (request: Connect.FixRequest, requester: Connect.Requester) {
        const found = yield* get(request.run, requester.sessionID)
        if (!found?.result || found.request.action !== "review")
          return yield* refusal("input", `There is no review ${request.run} in this session to fix.`)
        const known = new Set(found.result.findings.map((finding) => finding.id))
        const missing = request.findings.filter((id) => !known.has(id))
        if (missing.length > 0)
          return yield* refusal("input", `${request.run} has no finding ${missing.slice(0, 5).join(", ")}.`)
        return found
      })

      // The reviewer reads the whole worktree with no external-directory question, and the read tool names each file
      // relative to it, so the check walks from where the reviewer's reads start, under the names it asks with.
      const checkReads = Effect.fnUntraced(function* (directory: string, rules: PermissionV1.Ruleset) {
        const patterns = ConnectPolicy.readPatterns(rules)
        if (patterns.length === 0) return
        const instance = yield* InstanceState.context
        const scanned = yield* Effect.tryPromise(async () => {
          const place = await reviewRoot(directory, instance)
          return scan(place.root, patterns, rules, { prefixes: place.prefixes })
        }).pipe(Effect.orElseSucceed(() => ({ error: true as const })))
        if ("error" in scanned)
          return yield* refusal(
            "read-rule",
            "Connect could not check this directory against this session's read rules, so it did not review it.",
          )
        if ("tooMany" in scanned)
          return yield* refusal(
            "read-rule",
            `This repository holds more than ${MAX_SCAN.toLocaleString("en-US")} files, too many for connect to check against this session's read rules, so it did not review it.`,
          )
        if (scanned.block) return yield* ConnectPolicy.readRefusal(scanned.block)
      })

      const progress = Effect.fnUntraced(function* (entry: Entry, update: ConnectAdapter.ProgressUpdate) {
        if (entry.run.status !== "running") return
        const at = update.at ?? (yield* Clock.currentTimeMillis)
        const message = clip(update.message.trim() || "Working", 500)
        const pass = update.pass?.trim() ? clip(update.pass.trim(), 64) : undefined
        entry.run = { ...entry.run, progress: { ...(pass ? { pass } : {}), message, at } }
        yield* publish(entry)
      })

      const finish = Effect.fnUntraced(function* (entry: Entry, exit: Exit.Exit<Connect.Result, Connect.Refusal>) {
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        // A cancel stops the helper sessions too: interrupting the adapter does not stop a session's own loop.
        if (interrupted && entry.call.promptOps)
          for (const sessionID of entry.sessions)
            yield* entry.call.promptOps.cancel(sessionID).pipe(Effect.catchCause(() => Effect.void))
        const result = Exit.isSuccess(exit) ? accepted(exit.value, entry) : resultOf(exit.cause, entry)
        const ended = yield* Clock.currentTimeMillis
        const { progress: _, ...rest } = entry.run
        entry.run = { ...rest, status: "done", result, time: { ...entry.run.time, ended } }
        yield* publish(entry)
        yield* Deferred.succeed(entry.done, entry.run)
      })

      const run: Interface["run"] = Effect.fn("ConnectHub.run")(function* (input: StartInput) {
        const id = Connect.RunID.create()
        const created = yield* Clock.currentTimeMillis
        // With connected tools off nothing is read, recorded or published: no run list, event or registry shows it.
        if (!flags.experimentalConnect) return unrecorded(id, input.request, created, "not-allowed", OFF)
        // The caller's request may carry anything a model or a client sent (the tool passes its arguments on), so it
        // is held to the schema first; one the schema refuses ends refused with `input`, unrecorded, before anything
        // is read or asked.
        const decoded = yield* decodeRequest({ ...input.request, id, requestID: id }).pipe(Effect.exit)
        if (Exit.isFailure(decoded))
          return unrecorded(
            id,
            input.request,
            created,
            "input",
            `The hand-off request is not valid, so connect did not start it: ${clip(why(decoded.cause), 600)}`,
          )
        const state = yield* InstanceState.get(ledger)
        const requester = decoded.value.requester
        const saved = requester.sessionID ? yield* recorded(requester.sessionID) : undefined
        const request: Connect.Request = { ...decoded.value, requestID: saved?.requestID ?? id }
        const entry: Entry = {
          run: { id, request, status: "queued", time: { created } },
          adapter: byID.get(request.to),
          call: input.call ?? {},
          sessions: new Set(),
          places: new Set(),
          asked: new Set(),
          controller: new AbortController(),
          done: yield* Deferred.make<Connect.Run>(),
          working: yield* Deferred.make<void>(),
          owed: yield* Deferred.make<boolean>(),
        }
        remember(state, entry)
        yield* publish(entry)

        const work = Effect.gen(function* () {
          if (entry.stop) return yield* Effect.interrupt
          const admission = yield* admit(entry, saved?.runs ?? [])
          const started = yield* Clock.currentTimeMillis
          entry.run = { ...entry.run, status: "running", time: { ...entry.run.time, started } }
          yield* publish(entry)
          return yield* admission.handle(request, admission.context)
        }).pipe(Effect.onExit((exit) => finish(entry, exit)))

        if (request.background) return yield* detach(entry, work)
        const fiber = yield* Effect.forkChild(work)
        entry.fiber = fiber
        const minutes = request.budget?.timeoutMinutes
        const signal = input.call?.abort
        const outcome = yield* Effect.raceAll([
          Fiber.await(fiber).pipe(Effect.as<Stop | undefined>(undefined)),
          ...(signal ? [aborted(signal).pipe(Effect.as<Stop | undefined>("caller"))] : []),
          ...(minutes ? [Effect.sleep(Duration.minutes(minutes)).pipe(Effect.as<Stop | undefined>("timeout"))] : []),
        ])
        if (outcome) yield* stopRun(entry, outcome)
        return yield* Deferred.await(entry.done)
      })

      // A background run: its work runs as a `connect` BackgroundJob, so it outlives the tool call. The caller waits
      // until the adapter's questions are behind it, the run ends, or the caller stops (which cancels the run). Which
      // of the caller and the note reports the end is decided in one step, so it is reported exactly once.
      const detach = (entry: Entry, work: Effect.Effect<Connect.Result, Connect.Refusal>) =>
        Effect.gen(function* () {
          const request = entry.run.request
          const minutes = request.budget?.timeoutMinutes
          // Stopping the job (deleting its session, say) cancels the run, and the job ends only once the run did.
          const job = Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(work)
            entry.fiber = fiber
            const outcome = yield* Effect.raceAll([
              Fiber.await(fiber).pipe(Effect.as<Stop | undefined>(undefined)),
              ...(minutes
                ? [Effect.sleep(Duration.minutes(minutes)).pipe(Effect.as<Stop | undefined>("timeout"))]
                : []),
            ])
            if (outcome) yield* stopRun(entry, outcome)
            return (yield* Deferred.await(entry.done)).result?.summary ?? ""
          }).pipe(Effect.onInterrupt(() => unstarted(entry)))
          yield* background
            .start({
              id: entry.run.id,
              type: JOB_TYPE,
              title: `VectorScope ${request.action}`,
              metadata: {
                parentSessionId: request.requester.sessionID,
                background: true,
                runID: entry.run.id,
                member: request.to,
                action: request.action,
              },
              promotable: false,
              onComplete: (info) => ended(entry, info),
              run: job,
            })
            .pipe(Effect.onInterrupt(() => unstarted(entry)))
          const signal = entry.call.abort
          const waited = yield* Effect.raceAll([
            Deferred.await(entry.done).pipe(Effect.as<"ended" | "working" | "caller">("ended")),
            Deferred.await(entry.working).pipe(Effect.as<"ended" | "working" | "caller">("working")),
            ...(signal ? [aborted(signal).pipe(Effect.as<"ended" | "working" | "caller">("caller"))] : []),
          ]).pipe(Effect.onInterrupt(() => stopRun(entry, "caller")))
          if (waited === "caller") yield* stopRun(entry, "caller")
          const owed = waited !== "caller" && entry.run.status !== "done"
          if (owed) entry.detached = true
          yield* Deferred.succeed(entry.owed, owed)
          return owed ? entry.run : yield* Deferred.await(entry.done)
        }).pipe(Effect.ensuring(Deferred.succeed(entry.owed, false)))

      // A background job stopped before or while its run went: the run is cancelled, and ends here even when its work
      // never started (the job registry was closing).
      const unstarted = (entry: Entry) =>
        entry.fiber
          ? stopRun(entry, "cancelled")
          : Effect.suspend(() => {
              entry.stop ??= "cancelled"
              entry.controller.abort()
              return entry.run.status === "done" ? Effect.void : finish(entry, Exit.interrupt())
            })

      // A background run ended. One its caller already reported owes nothing; one Vector stopped while going away is
      // lost, as a restart loses it, and its part reads as cut off. Any other is written into its tool part, the only
      // place a run is read back from, and reported once through TaskNotify.
      const ended = Effect.fnUntraced(function* (entry: Entry, info: BackgroundJob.Info) {
        if (!(yield* Deferred.await(entry.owed)) || info.status === "interrupted") return
        const run = entry.run
        const sessionID = run.request.requester.sessionID
        const part = entry.call.part
        if (part)
          yield* SubagentLifecycle.patchPart({
            sessions,
            messageID: part.messageID,
            callID: part.callID,
            patch: metadata(run),
          }).pipe(Effect.provideService(Database.Service, database), Effect.forkIn(scope, { startImmediately: true }))
        const ops = entry.call.promptOps
        if (!sessionID || !ops) return
        yield* notify.enqueue({
          parentID: sessionID,
          note: ConnectNote.note(run, part?.messageID),
          ops,
          agent: run.request.requester.agent ?? (yield* agents.defaultAgent()),
        })
      })

      const members: Interface["members"] = Effect.fn("ConnectHub.members")(function* (input) {
        const state = yield* InstanceState.get(ledger)
        const ctx = yield* InstanceState.context
        const described = yield* Effect.forEach(adapters, describeSafely)
        const local = (yield* config.localPolicy()).enabled
        const agentList = yield* agents.list()
        const skillList = yield* skills.all()
        const workflows = yield* library.list().pipe(Effect.orElseSucceed(() => []))
        const status = yield* mcp.status()
        const remoteMcp = new Set(
          Object.entries((yield* config.get()).mcp ?? {}).flatMap(([name, entry]) =>
            entry && typeof entry === "object" && "type" in entry && entry.type === "remote" ? [name] : [],
          ),
        )
        const githubAgent = yield* Effect.promise(() => isFile(path.join(ctx.worktree, WORKFLOW_FILE)))
        const tasks = input?.sessionID
          ? yield* desktop
              .list({ sessionID: input.sessionID, descendants: true })
              .pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        const active = (prefix: string) =>
          (tasks?.tasks ?? []).filter(
            (task) => task.id.startsWith(prefix) && ["queued", "running", "waiting_on_user"].includes(task.status),
          ).length
        const list = ConnectMembers.compose({
          adapters: described,
          agents: agentList,
          skills: skillList,
          workflows,
          mcp: status,
          remoteMcp,
          ...(input?.tools ? { tools: input.tools } : {}),
          githubAgent,
          ...(tasks ? { desktop: { workspaces: active("workspace:"), swarm: active("swarm:") } } : {}),
          local,
        })
        return list.map((member) => withActivity(member, state))
      })

      return Service.of({ run, cancel, get, runs, request, members })
    }),
  )

/** The engine's hub, over every adapter in connect/adapters. */
export const layer = layerWith(ADAPTERS)

// Agent, Skill, MCP, WorkflowLibrary and DesktopTasks are already in the tool registry's graph (through ResearchRun,
// WorkflowRuns and TaskManager), so the registry depending on the hub adds no service it did not build before. The hub
// never depends on SessionPrompt or the registry: the helper handle is built from the prompt calls a caller lends it.
// The adapters' own services (connect/adapters `DEPS`: the review's provider, model, git and Brain services) join
// these in `node`; none of them reaches the prompt loop either. BackgroundJob and TaskNotify (background runs, CW-08)
// are in the registry's graph too, through the task tool; Database is the tool-part write's.
/** The hub's own dependencies, without its adapters'. */
export const DEPS = [
  RuntimeFlags.node,
  Permission.node,
  Session.node,
  SpendGuard.node,
  Agent.node,
  Config.node,
  EventV2Bridge.node,
  Skill.node,
  MCP.node,
  WorkflowLibrary.node,
  DesktopTasks.node,
  BackgroundJob.node,
  TaskNotify.node,
  Database.node,
] as const

export const node = LayerNode.make({ service: Service, layer, deps: [...DEPS, ...ADAPTER_DEPS] })

/** The hub over other adapters, with its own dependencies; for tests. */
export const nodeWith = (adapters: readonly ConnectAdapter.Adapter[]) =>
  LayerNode.make({
    service: Service,
    layer: layerWith(adapters.map((adapter) => Effect.succeed(adapter))),
    deps: DEPS,
  })

// ---------------------------------------------------------------------------------------------------------------

/** Keeps the ledger to its size, dropping the oldest finished runs first. */
function remember(state: State, entry: Entry) {
  state.runs.set(entry.run.id, entry)
  for (const [id, old] of state.runs) {
    if (state.runs.size <= LEDGER_SIZE) break
    if (old.run.status === "done") state.runs.delete(id)
  }
}

/** The most `connect_model` answers kept per instance; the oldest go first, so an old request may ask again. */
const MODEL_ANSWERS = 500

function approve(state: State, key: string) {
  state.models.add(key)
  for (const old of state.models) {
    if (state.models.size <= MODEL_ANSWERS) break
    state.models.delete(old)
  }
}

/**
 * The review runs a request already started: those saved in the session since the user last wrote and those in the
 * ledger for the same request, each once. A refused run did no work, so it does not count.
 */
function reviews(
  state: State,
  sessionID: SessionID | undefined,
  requestID: string | undefined,
  saved: readonly Connect.Run[],
  except?: string,
) {
  const counted = new Set<string>()
  const count = (run: Connect.Run) => {
    if (run.id === except || run.request.action !== "review" || run.result?.state === "refused") return
    counted.add(run.id)
  }
  saved.forEach(count)
  if (requestID && sessionID)
    for (const entry of state.runs.values())
      if (entry.run.request.requestID === requestID && entry.run.request.requester.sessionID === sessionID)
        count(entry.run)
  return counted.size
}

function withActivity(member: Connect.Member, state: State): Connect.Member {
  const runs = [...state.runs.values()].filter((entry) => entry.run.request.to === member.id)
  if (runs.length === 0) return member
  const running = runs.filter((entry) => entry.run.status !== "done").length
  const last = Math.max(...runs.map((entry) => entry.run.time.created))
  return { ...member, activity: { running, lastRunAt: last } }
}

const describeSafely = (adapter: ConnectAdapter.Adapter) =>
  adapter.describe().pipe(
    Effect.exit,
    Effect.map((exit): Connect.Member => {
      const member = Exit.isSuccess(exit) ? Option.getOrUndefined(decodeMember(exit.value)) : undefined
      if (member && member.id === adapter.id) return member
      // A member that cannot prove it is ready shows as unavailable.
      return {
        id: adapter.id,
        kind: "agent",
        title: adapter.id,
        summary: "",
        owner: adapter.owner,
        place: "local",
        state: "unavailable",
        reason: Exit.isSuccess(exit)
          ? "It described itself in a shape connect does not accept."
          : "Connect could not check whether it is ready.",
        reach: "none",
      }
    }),
  )

/** A result the adapter returned, held to the schema and given the sessions the hub saw. */
function accepted(result: Connect.Result, entry: Entry): Connect.Result {
  const request = entry.run.request
  const sessions = [...new Set([...result.sessions, ...entry.sessions])].slice(0, Connect.MAX_SESSIONS)
  const candidate = {
    ...result,
    sessions,
    ...(request.action === "review" && result.target === undefined ? { target: request.target } : {}),
  }
  return (
    Option.getOrUndefined(decodeResult(candidate)) ??
    ended(entry, "failed", `${request.to} returned a result connect does not accept, so connect did not use it.`)
  )
}

function resultOf(cause: Cause.Cause<Connect.Refusal>, entry: Entry): Connect.Result {
  const refused = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (refused) return { ...ended(entry, "refused", refused.message), refusal: refused.code }
  if (Cause.hasInterruptsOnly(cause)) {
    const minutes = entry.run.request.budget?.timeoutMinutes
    if (entry.stop === "timeout" && minutes)
      return ended(
        entry,
        "cancelled",
        `Stopped after ${minutes} ${minutes === 1 ? "minute" : "minutes"}, this hand-off's time limit.`,
      )
    if (entry.stop === "caller") return ended(entry, "cancelled", "Cancelled: the caller stopped waiting.")
    return ended(entry, "cancelled", "Cancelled.")
  }
  const error = Cause.squash(cause)
  const why = error instanceof Error ? error.message : String(error)
  return ended(
    entry,
    "failed",
    `The hand-off to ${entry.run.request.to} failed: ${clip(why || "no reason was given", 400)}`,
  )
}

function ended(entry: Entry, state: "refused" | "failed" | "cancelled", summary: string): Connect.Result {
  const request = entry.run.request
  return {
    state,
    ...(request.action === "review" ? { verdict: "not-reviewed" as const, target: request.target } : {}),
    summary: clip(summary, Connect.MAX_SUMMARY),
    findings: [],
    sessions: [...entry.sessions].slice(0, Connect.MAX_SESSIONS),
    notes: [],
  }
}

/**
 * A run refused before it was recorded: connected tools are off, or the request is not valid. It carries the caller's
 * request as given (it was never decoded, so `metadata` may save nothing for it) and is neither kept in the ledger nor
 * published.
 */
function unrecorded(
  id: Connect.RunID,
  request: StartRequest,
  created: number,
  code: Connect.RefusalCode,
  message: string,
): Connect.Run {
  const given = (typeof request === "object" && request !== null ? request : {}) as Partial<Connect.Request>
  return {
    id,
    request: { ...given, id, requestID: id } as Connect.Request,
    status: "done",
    result: {
      state: "refused",
      refusal: code,
      ...(given.action === "review" ? { verdict: "not-reviewed" as const } : {}),
      summary: clip(message, Connect.MAX_SUMMARY),
      findings: [],
      sessions: [],
      notes: [],
    },
    time: { created, ended: created },
  }
}

/** Why the schema refused a value, in a line. */
function why(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, " ").trim() || "it does not match the shape connect accepts"
}

/** A rule's deny or the user's no, as a refusal; anything else is not one. */
function refusalOf(cause: Cause.Cause<unknown>, consent: Connect.Consent, nobody: boolean) {
  for (const reason of cause.reasons) {
    const error = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
    if (error instanceof PermissionV1.DeniedError)
      return refusal(
        "permission",
        `A permission rule in this session denies ${consent.permission} for ${consent.patterns.join(", ")}, so connect did not go on.`,
      )
    if (error instanceof PermissionV1.CorrectedError)
      return refusal("denied", `The user declined ${consent.permission}: ${clip(error.feedback, 1_000)}`)
    if (error instanceof PermissionV1.RejectedError)
      return refusal(
        "denied",
        nobody
          ? `This hand-off has no session to ask ${consent.permission} in, so connect did not go on.`
          : `The user declined ${consent.permission}, so connect did not go on.`,
      )
  }
  return undefined
}

/** Resolves when the signal fires. */
function aborted(signal: AbortSignal) {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const fire = () => resume(Effect.void)
    signal.addEventListener("abort", fire, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", fire))
  })
}

/**
 * Where a review's reads are checked from, and the other names its files are asked under. Inside the instance's
 * worktree (the repository's top level) a reviewer reads any file with no external-directory question, VectorScope
 * reviews from that top level, and the read tool names each file relative to it; so a folder inside the worktree is
 * checked from the worktree's top, under those names. A folder of an instance that is not in git (worktree "/") is
 * checked from the folder itself, and its files are also named as the read tool names them there, relative to "/". A
 * folder outside the instance (a task's own worktree) is checked from the nearest folder at or above it that holds
 * `.git`, its repository's top level, or from the folder itself.
 */
export async function reviewRoot(
  directory: string,
  instance: { readonly directory: string; readonly worktree: string },
): Promise<{ readonly root: string; readonly prefixes: readonly string[] }> {
  const folder = await realpath(directory)
  const worktree = instance.worktree === "/" ? undefined : await realpath(instance.worktree).catch(() => undefined)
  if (worktree && FSUtil.contains(worktree, folder)) return { root: worktree, prefixes: [] }
  const home = await realpath(instance.directory).catch(() => undefined)
  if (instance.worktree === "/" && home && FSUtil.contains(home, folder)) {
    const named = [path.resolve(directory), folder].map((value) => path.relative("/", value).replaceAll("\\", "/"))
    return { root: folder, prefixes: [...new Set(named)].filter(Boolean) }
  }
  for (let current = folder; ; current = path.dirname(current)) {
    if (await exists(path.join(current, ".git"))) return { root: current, prefixes: [] }
    if (path.dirname(current) === current) return { root: folder, prefixes: [] }
  }
}

/**
 * Looks for a file or directory the review must not read, as `ConnectPolicy.readBlock` decides it: tracked, untracked
 * and ignored files alike, never inside `.git`. Each entry is named relative to `root`, and also under each of
 * `prefixes` (other names the read tool asks with). A directory is entered only when one of the patterns could match
 * something beneath it. A link to a directory inside `root` is walked again under its own name, once, when some rule
 * could tell a file reached through it from the same file under its real name (`ConnectPolicy.sameBeneath`), because a
 * reviewer reading through it asks with that name; otherwise its files are checked where they really lie. A link that
 * leaves `root` is an external read, which review sessions are denied. A folder that vanished during the walk holds
 * nothing to read; any other error throws, and the caller refuses (fail closed).
 */
export async function scan(
  root: string,
  patterns: readonly string[],
  rules: PermissionV1.Ruleset,
  options: { readonly limit?: number; readonly prefixes?: readonly string[] } = {},
): Promise<{ readonly block?: NonNullable<ReturnType<typeof ConnectPolicy.readBlock>> } | { readonly tooMany: true }> {
  const limit = options.limit ?? MAX_SCAN
  const prefixes = options.prefixes ?? []
  const review = ConnectPolicy.reviewRules()
  // Every pattern that can decide a read: the requester's read rules, the ask when none matches, and VectorScope's.
  const deciders = [...new Set(["*", ...[...rules, ...review].filter(readRule).map((rule) => rule.pattern)])]
  const home = await realpath(root)
  const visited = new Set<string>([home])
  const names = (relative: string) => [
    relative,
    ...prefixes.map((prefix) => (relative ? `${prefix}/${relative}` : prefix)),
  ]
  const beneath = (relative: string) =>
    names(relative).some((name) => patterns.some((pattern) => ConnectPolicy.overlaps(pattern, `${name}/*`)))
  const blocked = (relative: string) => {
    for (const name of names(relative)) {
      if (!patterns.some((pattern) => Wildcard.match(name, pattern))) continue
      const block = ConnectPolicy.readBlock(name, rules, review)
      if (block) return block
    }
    return undefined
  }
  const telling = (link: string, real: string) => {
    const reals = names(real)
    return names(link).some((name, index) => !ConnectPolicy.sameBeneath(deciders, name, reals[index]!))
  }
  const stack = [""]
  let seen = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch((error: unknown) => {
      if (dir !== "" && gone(error)) return []
      throw error
    })
    for (const entry of entries) {
      if (entry.name === ".git") continue
      seen += 1
      if (seen > limit) return { tooMany: true }
      const relative = dir ? `${dir}/${entry.name}` : entry.name
      const block = blocked(relative)
      if (block) return { block }
      if (entry.isDirectory()) {
        if (beneath(relative)) stack.push(relative)
        continue
      }
      if (!entry.isSymbolicLink() || !beneath(relative)) continue
      const target = await realpath(path.join(root, relative)).catch(() => undefined)
      if (!target || visited.has(target) || !(target === home || target.startsWith(home + path.sep))) continue
      if (!(await isDirectory(target))) continue
      const real = path.relative(home, target).replaceAll("\\", "/")
      // Where the walk never goes (.git), its files are checked only through the link.
      if (!real.split("/").includes(".git") && !telling(relative, real)) continue
      visited.add(target)
      stack.push(relative)
    }
  }
  return {}
}

function readRule(rule: PermissionV1.Rule) {
  return Wildcard.match("read", rule.permission)
}

/** An error that says the folder is no longer there (removed, or replaced by a file, while the walk ran). */
function gone(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

async function exists(target: string) {
  return stat(target)
    .then(() => true)
    .catch(() => false)
}

async function isDirectory(target: string) {
  return stat(target)
    .then((info) => info.isDirectory())
    .catch(() => false)
}

async function isFile(target: string) {
  return stat(target)
    .then((info) => info.isFile())
    .catch(() => false)
}

function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}
