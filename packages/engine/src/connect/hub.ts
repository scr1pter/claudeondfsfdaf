export * as ConnectHub from "./hub"

import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ConnectFindings } from "@vectordevai/core/connect/findings"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Connect } from "@vectordevai/schema/connect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { WorkflowLibrary } from "@/orchestration/library"
import { Permission } from "@/permission"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Skill } from "@/skill"
import { DesktopTasks } from "@/task/desktop"
// Types only, as everywhere in connect: the hub must stay out of the prompt loop's module graph.
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import type { ConnectAdapter } from "./adapter"
import { ADAPTERS } from "./adapters"
import { ConnectMembers } from "./members"

// Connected tools' hub: one place where every hand-off starts, is checked, asks, runs, is recorded and ends.
//
// A hand-off starts from an agent's tool call, a workflow stage or a person, never from a member. Before anything is
// asked the hub checks, in order: the member and its action exist; every effect the member declared is one connect
// accepts (`read`, `write`) and the requester's own rules do not deny the permission it maps to; the member is ready;
// for a review, the per-request cap and the requester's read rules over every file in the directory. Only then does it
// ask `connect` in the requester's session, and hand the work to the adapter with a context that asks the rest
// (`connect_model`, `connect_write`) and reports progress. The adapter reaches the prompt loop only through a helper
// handle that accepts the run's own hidden helper sessions, and only the vectorscope adapter gets one.
//
// Results persist with the session: the caller saves `metadata(run)` in the `connect` tool part (or a connect note),
// and `get`, `since` and `fix` find a run there after a restart. The in-memory ledger keeps the last 50 runs of each
// instance as a cache and holds what is running, so a run can be cancelled from anywhere. The hub itself makes no
// network call and no model call: only adapters do work, through the handle.

/** The most runs the in-memory ledger keeps per instance. Runs still going are never dropped. */
export const LEDGER_SIZE = 50
/** The key of a run in a tool part's or a note's metadata. */
export const METADATA_KEY = "connect"
/** The members that receive a helper handle. */
export const HELPER_MEMBERS: ReadonlySet<string> = new Set(["vectorscope"])
/** The most files and directories the read check looks at before it refuses (fail closed). */
export const MAX_SCAN = 500_000

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
}

export interface StartInput {
  readonly request: StartRequest
  readonly call?: Call
}

export interface Interface {
  /**
   * Starts a hand-off and waits for it. It never fails: a refusal, a failure, a timeout or a cancel ends the run with
   * that result. Background runs arrive with CW-08 and are refused until then.
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
 * The run a stored part carries: a `connect` tool part, or a synthetic note with a run in its metadata. Anything
 * else, or a run the schema does not accept, is no run.
 */
export function fromPart(part: SessionV1.Part): Connect.Run | undefined {
  const raw =
    part.type === "tool" && part.tool === "connect" && "metadata" in part.state
      ? part.state.metadata?.[METADATA_KEY]
      : part.type === "text" && part.synthetic
        ? part.metadata?.[METADATA_KEY]
        : undefined
  if (raw === undefined) return undefined
  return Option.getOrUndefined(decodeRun(raw))
}

/** Whether a stored message is one the user wrote, rather than a note Vector wrote into the session. */
export function written(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "user") return false
  return message.parts.some((part) =>
    part.type === "text" ? !part.synthetic : part.type === "file" || part.type === "agent" || part.type === "subtask",
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
  /** Consents already asked in this run. */
  readonly asked: Set<string>
  readonly controller: AbortController
  readonly done: Deferred.Deferred<Connect.Run>
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
        if (entry.call.update) yield* entry.call.update(entry.run).pipe(Effect.catchCause(() => Effect.void))
      })

      // Runs recorded in a session since the user last wrote, newest first, read without loading the whole history.
      const recorded = Effect.fnUntraced(function* (sessionID: SessionID) {
        const runs: Connect.Run[] = []
        const found = yield* sessions
          .findMessage(sessionID, (message) => {
            if (written(message)) return true
            for (const part of message.parts) {
              const run = fromPart(part)
              if (run) runs.push(run)
            }
            return false
          })
          .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
        return { requestID: Option.getOrUndefined(Option.map(found, (message) => message.info.id)), runs }
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
        let match: Connect.Run | undefined
        yield* sessions
          .findMessage(sessionID, (message) =>
            message.parts.some((part) => {
              const run = fromPart(part)
              if (run?.id !== runID) return false
              match = run
              return true
            }),
          )
          .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
        return match
      })

      const runs: Interface["runs"] = Effect.fn("ConnectHub.runs")(function* (input) {
        const state = yield* InstanceState.get(ledger)
        return [...state.runs.values()]
          .map((entry) => entry.run)
          .filter((run) => input?.sessionID === undefined || run.request.requester.sessionID === input.sessionID)
          .toSorted((a, b) => b.time.created - a.time.created || (a.id < b.id ? 1 : -1))
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
          const call = entry.call.ask
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

      // Accepts only the run's own hidden helper sessions while the run is going (HelperHandle).
      const helperFor = (entry: Entry, ops: TaskPromptOps, member: string): ConnectAdapter.HelperHandle => {
        const requester = entry.run.request.requester.sessionID
        const admit = Effect.fnUntraced(function* (sessionID: SessionID) {
          const refuse = (why: string) =>
            Effect.die(new Error(`Connect's helper handle refused session ${sessionID}: ${why}`))
          if (entry.run.status !== "running") return yield* refuse("the run is not going")
          if (sessionID === requester) return yield* refuse("it is the requester's own session")
          const info = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
          if (!info) return yield* refuse("there is no such session")
          if (!info.internal?.startsWith(`${member}.`)) return yield* refuse(`it is not a hidden ${member} helper`)
          const parent = info.parentID
          if (!parent || (parent !== requester && !entry.places.has(parent)))
            return yield* refuse("its parent is not this run's requester")
          if (!entry.sessions.has(sessionID) && entry.sessions.size >= Connect.MAX_SESSIONS)
            return yield* refuse(`the run already made ${Connect.MAX_SESSIONS} helper sessions`)
        })
        return {
          prompt: (input) =>
            Effect.gen(function* () {
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
        if (!flags.experimentalConnect)
          return yield* refusal("not-allowed", "Connected tools are off in this build (VECTOR_EXPERIMENTAL_CONNECT).")
        if (request.background)
          return yield* refusal("input", "Background hand-offs are not available yet. Run it in the foreground.")
        const session = requester.sessionID
          ? yield* sessions.get(requester.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        if (requester.sessionID && !session)
          return yield* refusal("not-allowed", "The session that asked no longer exists, so connect did not start.")
        // A member's own helper session never starts a hand-off (no chains).
        if (session?.internal)
          return yield* refusal("not-allowed", "A helper session cannot hand work to another member.")
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
        if (member.state !== "ready")
          return yield* refusal(
            "unavailable",
            `${member.title} is not ready${member.reason ? `: ${member.reason}` : "."}`,
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
        const spend = yield* spendOf(requester.sessionID)
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
          ...(ops && HELPER_MEMBERS.has(adapter.id) ? { helper: helperFor(entry, ops, adapter.id) } : {}),
          ...(remainingUsd !== undefined ? { remainingUsd } : {}),
          spend,
          ...(previous ? { previous } : {}),
          ...(source ? { source } : {}),
        }
        return { context, handle: adapter.handle } satisfies Admission
      })

      const earlier = Effect.fnUntraced(function* (request: Connect.ReviewRequest, requester: Connect.Requester) {
        const since = request.since!
        const found = yield* get(since, requester.sessionID)
        if (!found?.result || found.request.action !== "review")
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

      const checkReads = Effect.fnUntraced(function* (directory: string, rules: PermissionV1.Ruleset) {
        const patterns = ConnectPolicy.readPatterns(rules)
        if (patterns.length === 0) return
        const scanned = yield* Effect.tryPromise(() => scan(directory, patterns, rules)).pipe(
          Effect.orElseSucceed(() => ({ error: true as const })),
        )
        if ("error" in scanned)
          return yield* refusal(
            "read-rule",
            "Connect could not check this directory against this session's read rules, so it did not review it.",
          )
        if ("tooMany" in scanned)
          return yield* refusal(
            "read-rule",
            `This directory holds more than ${MAX_SCAN.toLocaleString("en-US")} files, too many for connect to check against this session's read rules, so it did not review it.`,
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
        const state = yield* InstanceState.get(ledger)
        const id = Connect.RunID.create()
        const requester = input.request.requester
        const saved = requester.sessionID ? yield* recorded(requester.sessionID) : undefined
        const request = yield* decodeRequest({ ...input.request, id, requestID: saved?.requestID ?? id }).pipe(
          Effect.orDie,
        )
        const created = yield* Clock.currentTimeMillis
        const entry: Entry = {
          run: { id, request, status: "queued", time: { created } },
          adapter: byID.get(request.to),
          call: input.call ?? {},
          sessions: new Set(),
          places: new Set(),
          asked: new Set(),
          controller: new AbortController(),
          done: yield* Deferred.make<Connect.Run>(),
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

      const members: Interface["members"] = Effect.fn("ConnectHub.members")(function* (input) {
        const state = yield* InstanceState.get(ledger)
        const ctx = yield* InstanceState.context
        const described = yield* Effect.forEach(adapters, describeSafely)
        const local = (yield* config.localPolicy()).enabled
        const agentList = yield* agents.list()
        const skillList = yield* skills.all()
        const workflows = yield* library.list().pipe(Effect.orElseSucceed(() => []))
        const status = yield* mcp.status()
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
const deps = [
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
] as const

export const node = LayerNode.make({ service: Service, layer, deps })

/** The hub over other adapters, with the same dependencies; for tests. */
export const nodeWith = (adapters: readonly ConnectAdapter.Adapter[]) =>
  LayerNode.make({ service: Service, layer: layerWith(adapters.map((adapter) => Effect.succeed(adapter))), deps })

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
 * Looks for a file or directory the review must not read, as `ConnectPolicy.readBlock` decides it: tracked, untracked
 * and ignored files alike, never inside `.git`. A directory is entered only when one of the patterns could match
 * something beneath it. A link to a directory inside the review directory is followed under its own name, once,
 * because a reviewer reading through it asks with that name; a link that leaves the directory is an external read,
 * which review sessions are denied.
 */
export async function scan(
  root: string,
  patterns: readonly string[],
  rules: PermissionV1.Ruleset,
  limit = MAX_SCAN,
): Promise<{ readonly block?: NonNullable<ReturnType<typeof ConnectPolicy.readBlock>> } | { readonly tooMany: true }> {
  const review = ConnectPolicy.reviewRules()
  const home = await realpath(root)
  const visited = new Set<string>([home])
  const beneath = (relative: string) => patterns.some((pattern) => ConnectPolicy.overlaps(pattern, `${relative}/*`))
  const blocked = (relative: string) =>
    patterns.some((pattern) => Wildcard.match(relative, pattern))
      ? ConnectPolicy.readBlock(relative, rules, review)
      : undefined
  const stack = [""]
  let seen = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])
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
      visited.add(target)
      stack.push(relative)
    }
  }
  return {}
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
