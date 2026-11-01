export * as TaskLimits from "./limits"

import { sql } from "drizzle-orm"
import {
  Context as ServiceContext,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import type { Task } from "@vectordevai/schema/task"
import { Database } from "@vectordevai/core/database/database"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTaskSize } from "@/session/task-size"
import { isRecord } from "@/util/record"

// How many subagents run at once in a conversation, how many one request may start, and whether the request's
// delegated spend ceiling still lets a launch through (multi-agent contract 5.B). A conversation is a root session, or
// for a desktop Parallel Workspace or Swarm session the conversation it was started from, so this is a global node:
// every workspace runs in its own instance. A launch is admitted before its ask, and its child takes a slot only when
// it starts work, so a child waiting on a dependency holds none. Root launches wait for a slot in one queue, ahead of
// workflow agents. A subagent's own launches never wait, because their parent holds a slot: they are refused instead.

/** ctx.extra flag for launches that are never counted: the judge and Vector's own. */
export const EXEMPT = "vector.task.exempt"
export const DEFAULTS = {
  running: ConfigV1.SubagentDefaults.running,
  perRequest: ConfigV1.SubagentDefaults.per_request,
  budget: { usd: ConfigV1.SubagentDefaults.usd },
} as const
export const GUEST = { running: 4, perRequest: 8, budget: { usd: 5 } } as const
export const MAX_RUNNING = 16
export const MAX_PER_REQUEST = 1000
/** Free slots workflow agents leave for task launches while any of them waits. */
export const WORKFLOW_RESERVE = 2
/** Above this many running or waiting subagents, a launch tells the agent to say how many are working. */
export const BUSY = 6
/** Why a child is queued once its prerequisites are met: every subagent slot of its conversation is taken (5.B.3). */
export const SLOT_REASON = "Waiting for a free subagent slot"
// Conversations and requests kept in memory; one dropped later is counted again from the database.
const POOLS = 256
const REQUESTS = 64

export type Limits = { running: number; perRequest: number; budget: RunBudget.Info }
/** ctx.extra.delegation, set for root, non-internal sessions. */
export type Context = { requestID: string }
export type Origin = "root" | "nested" | "workflow" | "resume"
export type Admission = {
  conversationID: string
  requestID: string
  limits: Limits
  origin: Origin
  count: number
  running: number
  queued: number
  /** Running, waiting and admitted but not yet started, this admission included. */
  active: number
  launched: number
  /** Whether the admitted children would wait for a slot now. */
  waits: boolean
  /** Slots reserved at admission; bind() hands them to the child. */
  prepaid: number
}
export type Status = {
  running: number
  queued: number
  limit: number
  launched: number
  perRequest: number
  spend?: Task.Limits["spend"]
}
/** What a request's children spent before this process, for the delegated ledger it creates. */
export type Seed = {
  readonly spentUsd: number
  readonly steps: number
  readonly unpricedSteps: number
  readonly codiumSteps: number
}

export class Refused extends Schema.TaggedErrorClass<Refused>()("TaskLimits.Refused", {
  reason: Schema.Literals(["per_request", "batch", "slots", "spend", "workflow_runs", "unavailable"]),
  message: Schema.String,
}) {}

const perRequest = (launched: number, max: number) =>
  new Refused({
    reason: "per_request",
    message: `This request has already started ${launched} of the ${max} subagents one request may start (budget.subagents.per_request). Do the remaining work yourself, or continue a finished child with its task_id. No child was started.`,
  })
const batch = (n: number, left: number) =>
  new Refused({
    reason: "batch",
    message: `This batch would start ${n} subagents, but this request may start only ${left} more (budget.subagents.per_request). Launch fewer, or do the rest yourself. No child was started.`,
  })
const slots = (limit: number) =>
  new Refused({
    reason: "slots",
    message: `All ${limit} subagent slots of this conversation are in use, and a subagent's own subagents cannot wait for one. Do this part yourself. No child was started.`,
  })
const spend = (spent: number, cap: number) =>
  new Refused({
    reason: "spend",
    message: `Subagents in this request reached their spend ceiling (${SpendGuard.formatUsd(spent)} of ${SpendGuard.formatUsd(cap)}). Do the remaining work yourself; the user can raise budget.subagents.usd, or a new request continues under a fresh ceiling. No child was started.`,
  })
// The request's launches and spend could not be read, so its limits cannot be checked.
const unavailable = () =>
  new Refused({
    reason: "unavailable",
    message:
      "Vector could not read how many subagents this request has started. Try again, or do the work yourself. No child was started.",
  })
/** The refusal for a workflow run launched while `runID` already runs in the conversation (budget.workflow.runs). */
export const workflowRuns = (runID: string) =>
  new Refused({
    reason: "workflow_runs",
    message: `A workflow is already running in this conversation (${runID}). Wait for it, stop it, or raise budget.workflow.runs.`,
  })

/** The user's limits, each clamped to its range; a guest gets the lower of each and the guest budget. */
export function resolve(config: Pick<ConfigV1.Info, "budget">, guest: boolean): Limits {
  const subagents = config.budget?.subagents
  const count = (value: number | undefined, fallback: number, max: number) =>
    value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(1, Math.floor(value)))
  const whole = (value: number | undefined) => (Number.isInteger(value) && value! > 0 ? value : undefined)
  const steps = whole(subagents?.steps)
  const unpricedSteps = whole(subagents?.unpricedSteps)
  const warnAt =
    subagents?.warnAt !== undefined && subagents.warnAt >= 0 && subagents.warnAt <= 1 ? subagents.warnAt : undefined
  const usd =
    subagents?.usd !== undefined && Number.isFinite(subagents.usd) && subagents.usd > 0 ? subagents.usd : undefined
  const owner: Limits = {
    running: count(subagents?.running, DEFAULTS.running, MAX_RUNNING),
    perRequest: count(subagents?.per_request, DEFAULTS.perRequest, MAX_PER_REQUEST),
    budget: {
      usd: usd ?? DEFAULTS.budget.usd,
      ...(steps !== undefined && { steps }),
      ...(warnAt !== undefined && { warnAt }),
      ...(unpricedSteps !== undefined && { unpricedSteps }),
    },
  }
  if (!guest) return owner
  return {
    running: Math.min(owner.running, GUEST.running),
    perRequest: Math.min(owner.perRequest, GUEST.perRequest),
    budget: SpendGuard.tighter(owner.budget, GUEST.budget),
  }
}

/** The id of a request's delegated ledger in SpendGuard. */
export function ledger(conversationID: string, requestID: string) {
  return `delegated:${conversationID}:${requestID}`
}

/**
 * The pool a session's launches count in: its root session, or for a root the desktop started as a Parallel Workspace
 * or Swarm session, the conversation of the session it names in the same project. One hop only, and never for a
 * guest-marked root, which keeps its own pool. `parentOf` looks a session up by id.
 */
export function conversation(
  session: Session.Info,
  parentOf: (id: string) => Session.Info | undefined,
  guest: boolean,
): string {
  const root = rootOf(session, parentOf)
  const vector = root.metadata?.vector
  if (guest || !vector || typeof vector !== "object") return root.id
  const fields = vector as Record<string, unknown>
  if (fields.kind !== "parallel-agent" || typeof fields.parentSessionId !== "string") return root.id
  const parent = parentOf(fields.parentSessionId)
  if (!parent || parent.projectID !== root.projectID) return root.id
  return rootOf(parent, parentOf).id
}

function rootOf(session: Session.Info, parentOf: (id: string) => Session.Info | undefined) {
  const seen = new Set<string>([session.id])
  let current = session
  while (current.parentID) {
    const parent = parentOf(current.parentID)
    if (!parent || seen.has(parent.id)) return current
    seen.add(parent.id)
    current = parent
  }
  return current
}

// Sessions above a root that conversation() reads: the session a desktop root names and that one's ancestors, at most
// as many as a subagent tree is deep.
const HOPS = 2

/** conversation() for a root, reading the sessions it names from the database. */
export const conversationOf = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "get">,
  root: Session.Info,
  guest: boolean,
) {
  const known = new Map<string, Session.Info>([[root.id, root]])
  const vector = root.metadata?.vector
  let next = isRecord(vector) && typeof vector.parentSessionId === "string" ? vector.parentSessionId : undefined
  for (let hops = 0; next !== undefined && !known.has(next) && hops <= HOPS; hops++) {
    const parsed = Schema.decodeUnknownOption(SessionID)(next)
    if (Option.isNone(parsed)) break
    const found = yield* sessions.get(parsed.value).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (!found) break
    known.set(found.id, found)
    next = found.parentID
  }
  return conversation(root, (id) => known.get(id), guest)
})

/**
 * A root's latest message from the user, the request its launches count in when its prompt loop has recorded none (5.B.2,
 * 5.B.10). A note, a judge's findings or a marker opens no request; a message with no parts yet counts as the user's.
 * The root's ID when none.
 */
export const currentRequest = (sessions: Pick<Session.Interface, "findMessage">, rootID: SessionID) =>
  sessions
    .findMessage(
      rootID,
      (message) => message.info.role === "user" && (message.parts.length === 0 || SessionTaskSize.real(message)),
    )
    .pipe(
      Effect.map((found): string => (Option.isSome(found) ? found.value.info.id : rootID)),
      Effect.catchCause(() => Effect.succeed<string>(rootID)),
    )

/**
 * The request a root's launches count in now: the one its prompt loop recorded with track(), so a message that joined
 * the running request or a "thanks" a completion note made work keeps the request that launches count in; else its
 * latest message from the user.
 */
export const requestFor = (
  limits: Pick<Interface, "tracked">,
  sessions: Pick<Session.Interface, "findMessage">,
  rootID: SessionID,
) =>
  limits
    .tracked(rootID)
    .pipe(Effect.flatMap((found) => (found === undefined ? currentRequest(sessions, rootID) : Effect.succeed(found))))

export type AdmitInput = {
  conversationID: string
  requestID: string
  limits: Limits
  origin: Origin
  count: number
  /** Extra slots held for the child's own launches, such as a research lead's researchers (B.5). */
  reserve?: number
  /** The launching session. A launch from a subagent first uses a slot that subagent reserved. */
  parentID?: string
}

export type RunInput = {
  conversationID: string
  childID: string
  origin: Origin
  /** Runs once when the child must wait for a slot, such as marking it queued. */
  waiting?: Effect.Effect<void>
}

export interface Interface {
  /** A batch's check before any child is prepared: refused whole when it would pass the per-request limit. */
  readonly capacity: (i: {
    conversationID: string
    requestID: string
    limits: Limits
    need: number
  }) => Effect.Effect<void, Refused>
  /** Admits a launch. Its per-request places and reserved slots are released when the scope closes unbound. */
  readonly admit: (i: AdmitInput) => Effect.Effect<Admission, Refused, Scope.Scope>
  /** Makes one place of the admission admit() returned, and its reserved slots, the child's, before its job starts. */
  readonly bind: (admission: Admission, childID: SessionID) => Effect.Effect<void>
  /** Gives back the slots bind() gave a child whose run never started, such as one stopped before its job ran. */
  readonly release: (admission: Admission, childID: SessionID) => Effect.Effect<void>
  /** Runs `effect` holding the child's slot, waiting for one when needed. Reentrant per child. */
  readonly run: <A, E, R>(i: RunInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** The conversation's counts and the request's delegated spend. `limits` replaces the ones last seen. */
  readonly status: (conversationID: string, requestID?: string, limits?: Limits) => Effect.Effect<Status>
  /** Counts the request's children and their spend from the database, once per key per process. */
  readonly seed: (conversationID: string, requestID: string) => Effect.Effect<Seed>
  /** Records the request a root session's launches count in, as its prompt loop worked it out for this step. */
  readonly track: (rootID: string, requestID: string) => Effect.Effect<void>
  /** The request track() last recorded for a root in this process. */
  readonly tracked: (rootID: string) => Effect.Effect<string | undefined>
}

export class Service extends ServiceContext.Service<Service, Interface>()("@vector/TaskLimits") {}

// A child holding slots inside run(): its own, plus `spare` slots it reserved for its launches. A child that borrowed
// its slot from a parent's spare gives it back there (`from`). `depth` counts the runs that share the slot.
type Holder = { readonly spare: number; readonly depth: number; readonly from?: string }
// Slots bound to a child before its run starts.
type Prepaid = { readonly spare: number; readonly from?: string; readonly admission: number }
// An admission whose scope is open. Each child takes `each` slots; `prepaid` ones were reserved at admission.
type Open = {
  readonly requestID: string
  readonly origin: Origin
  readonly counted: boolean
  readonly count: number
  readonly each: number
  readonly prepaid: boolean
  // Launched from a subagent: its child runs in the foreground, inside this admission's scope.
  readonly nested: boolean
  readonly from?: string
  readonly bound: readonly string[]
  readonly started: readonly string[]
}
type Waiter = {
  readonly id: number
  readonly childID: string
  readonly origin: Origin
  readonly spare: number
  readonly parties: number
  readonly deferred: Deferred.Deferred<void>
}
type Request = { readonly launched: number; readonly pending: number; readonly seed: Seed }
// What withSeed's function returned, and whether the request's count was read (else nothing counted was assumed).
type Seeded<B> = { readonly value: B; readonly seeded: boolean }
type Pool = {
  readonly limits?: Limits
  readonly held: ReadonlyMap<string, Holder>
  readonly prepaid: ReadonlyMap<string, Prepaid>
  readonly open: ReadonlyMap<number, Open>
  // In arrival order. A root waiter goes before every workflow waiter (drain).
  readonly queue: readonly Waiter[]
  // Spare slots a child admitted without them reserves when its run starts.
  readonly reserves: ReadonlyMap<string, number>
  readonly requests: ReadonlyMap<string, Request>
}

const EMPTY: Pool = {
  held: new Map(),
  prepaid: new Map(),
  open: new Map(),
  queue: [],
  reserves: new Map(),
  requests: new Map(),
}
const NONE: Seed = { spentUsd: 0, steps: 0, unpricedSteps: 0, codiumSteps: 0 }

const counts = (origin: Origin) => origin === "root" || origin === "nested"
const limitOf = (pool: Pool) => pool.limits?.running ?? DEFAULTS.running
// Workflow agents never take the last free slots, so task launches start at once; with one or two slots they still run.
const kept = (limit: number) => Math.min(WORKFLOW_RESERVE, limit - 1)

function occupied(pool: Pool) {
  let total = 0
  pool.held.forEach((holder) => (total += 1 + holder.spare))
  pool.prepaid.forEach((paid) => (total += 1 + paid.spare))
  pool.open.forEach((open) => {
    if (open.prepaid) total += (open.count - open.bound.length) * open.each
  })
  return total
}

const freeOf = (pool: Pool) => limitOf(pool) - occupied(pool)

// A waiter that comes first: any one for a workflow agent, only a root one for anything else.
const ahead = (pool: Pool, origin: Origin) =>
  origin === "workflow" ? pool.queue.length > 0 : pool.queue.some((waiter) => waiter.origin !== "workflow")

function fits(pool: Pool, origin: Origin, need: number, demand = 0) {
  const free = freeOf(pool) - demand
  return origin === "workflow" ? free - need >= kept(limitOf(pool)) : free >= need
}

// Slots admitted launches will ask for once they start, which a later admission waits behind.
function demand(pool: Pool, origin: Origin) {
  let total = 0
  pool.open.forEach((open) => {
    if (open.prepaid || (origin !== "workflow" && open.origin === "workflow")) return
    total += (open.count - open.started.length) * open.each
  })
  return total
}

// Admitted children not yet running, beside running and waiting ones.
function uncommitted(pool: Pool) {
  let total = 0
  pool.open.forEach((open) => (total += open.count - open.started.length))
  pool.prepaid.forEach((paid) => {
    if (!pool.open.has(paid.admission)) total += 1
  })
  return total
}

const lenderOf = (pool: Pool, id: string) => pool.held.get(id) ?? pool.prepaid.get(id)

function lend(pool: Pool, id: string, delta: number): Pool {
  const holder = pool.held.get(id)
  if (holder) return { ...pool, held: new Map(pool.held).set(id, { ...holder, spare: holder.spare + delta }) }
  const paid = pool.prepaid.get(id)
  if (paid) return { ...pool, prepaid: new Map(pool.prepaid).set(id, { ...paid, spare: paid.spare + delta }) }
  return pool
}

// Slots no one holds any more go back to the parent they were borrowed from, else to the conversation.
const give = (pool: Pool, from: string | undefined, count: number) =>
  from !== undefined && lenderOf(pool, from) ? lend(pool, from, count) : pool

function withRequest(pool: Pool, requestID: string, request: Request): Pool {
  const requests = new Map(pool.requests)
  requests.delete(requestID)
  requests.set(requestID, request)
  for (const [id, entry] of requests) {
    if (requests.size <= REQUESTS) break
    if (entry.pending === 0 && id !== requestID) requests.delete(id)
  }
  return { ...pool, requests }
}

const requestOf = (pool: Pool, requestID: string): Request =>
  pool.requests.get(requestID) ?? { launched: 0, pending: 0, seed: NONE }

// Grants slots to waiters in order: the first root waiter, else the first workflow waiter. Strict order: a head that
// does not fit yet keeps every slot freed until it does.
function drain(pool: Pool): readonly [Pool, Deferred.Deferred<void>[]] {
  let next = pool
  const woken: Deferred.Deferred<void>[] = []
  while (true) {
    const head = next.queue.find((waiter) => waiter.origin !== "workflow") ?? next.queue[0]
    if (!head || !fits(next, head.origin, 1 + head.spare)) break
    const held = next.held.get(head.childID)
    next = {
      ...next,
      queue: next.queue.filter((waiter) => waiter !== head),
      held: new Map(next.held).set(
        head.childID,
        held ? { ...held, depth: held.depth + head.parties } : { spare: head.spare, depth: head.parties },
      ),
    }
    woken.push(head.deferred)
  }
  return [next, woken]
}

// The limits from the current config apply at once: a raised running limit starts the waiters it now has room for.
const limited = (pool: Pool, limits: Limits | undefined) => (limits ? drain({ ...pool, limits }) : drain(pool))

type Placed = { readonly admission: Admission } | { readonly refused: Refused }

function place(pool: Pool, i: AdmitInput, id: number): readonly [Placed, Pool] {
  const counted = counts(i.origin)
  const request = requestOf(pool, i.requestID)
  const current: Pool = { ...pool, limits: i.limits }
  if (counted && request.launched + request.pending + i.count > i.limits.perRequest)
    return [{ refused: perRequest(request.launched + request.pending, i.limits.perRequest) }, current]
  // A reserve never asks for every slot of the conversation, so it can always be granted.
  const each = 1 + Math.min(Math.max(0, Math.floor(i.reserve ?? 0)), i.limits.running - 1)
  const need = i.count * each
  const lender = i.parentID === undefined ? undefined : lenderOf(current, i.parentID)
  // A launch from a subagent, or a resume from one, cannot wait for a slot its own parent may be holding.
  const nested = i.origin === "nested" || (i.origin === "resume" && lender !== undefined)
  let next = current
  let prepaid = false
  let from: string | undefined
  let waits = false
  if (nested) {
    if (lender && lender.spare >= need && i.parentID !== undefined) {
      from = i.parentID
      next = lend(next, i.parentID, -need)
    } else if (ahead(current, i.origin) || freeOf(current) < need)
      return [{ refused: slots(i.limits.running) }, current]
    prepaid = true
  } else {
    waits = ahead(current, i.origin) || !fits(current, i.origin, need, demand(current, i.origin))
    // A launch that reserves slots for its own launches takes them all now, or waits for them all in run().
    prepaid = each > 1 && !waits
  }
  const open: Open = {
    requestID: i.requestID,
    origin: i.origin,
    counted,
    count: i.count,
    each,
    prepaid,
    nested,
    from,
    bound: [],
    started: [],
  }
  next = { ...next, open: new Map(next.open).set(id, open) }
  if (counted) next = withRequest(next, i.requestID, { ...request, pending: request.pending + i.count })
  const admission: Admission = {
    conversationID: i.conversationID,
    requestID: i.requestID,
    limits: i.limits,
    origin: i.origin,
    count: i.count,
    running: next.held.size,
    queued: next.queue.length,
    active: next.held.size + next.queue.length + uncommitted(next),
    launched: request.launched + request.pending + (counted ? i.count : 0),
    waits,
    prepaid: prepaid ? need : 0,
  }
  return [{ admission }, next]
}

function bound(pool: Pool, id: number, childID: string): Pool {
  const open = pool.open.get(id)
  if (!open || open.bound.includes(childID) || open.bound.length >= open.count) return pool
  let next: Pool = { ...pool, open: new Map(pool.open).set(id, { ...open, bound: [...open.bound, childID] }) }
  if (open.counted) {
    const request = requestOf(next, open.requestID)
    next = withRequest(next, open.requestID, {
      ...request,
      pending: Math.max(0, request.pending - 1),
      launched: request.launched + 1,
    })
  }
  if (!open.prepaid) {
    if (open.each > 1) next = { ...next, reserves: new Map(next.reserves).set(childID, open.each - 1) }
    return next
  }
  // A child that already holds a slot keeps that one, and the slots reserved for it go back.
  if (next.held.has(childID) || next.prepaid.has(childID)) return give(next, open.from, open.each)
  return {
    ...next,
    prepaid: new Map(next.prepaid).set(childID, { spare: open.each - 1, from: open.from, admission: id }),
  }
}

// A child whose run never started gives back what its admission bound to it; one that ran gave it back on leaving.
function unstarted(pool: Pool, id: number, childID: string): Pool {
  const paid = pool.prepaid.get(childID)
  let next = pool
  if (paid?.admission === id) {
    const prepaid = new Map(pool.prepaid)
    prepaid.delete(childID)
    next = give({ ...pool, prepaid }, paid.from, 1 + paid.spare)
  }
  const waiting = next.held.has(childID) || next.queue.some((waiter) => waiter.childID === childID)
  if (waiting || !next.reserves.has(childID)) return next
  const reserves = new Map(next.reserves)
  reserves.delete(childID)
  return { ...next, reserves }
}

function closed(pool: Pool, id: number, failed: boolean): Pool {
  const open = pool.open.get(id)
  if (!open) return pool
  const remaining = new Map(pool.open)
  remaining.delete(id)
  let next: Pool = { ...pool, open: remaining }
  const unbound = open.count - open.bound.length
  if (open.prepaid && unbound > 0) next = give(next, open.from, unbound * open.each)
  let released = 0
  // A child whose launch failed never starts, and a subagent's child runs inside this scope, so one that has not
  // started by now never will: what was reserved for it goes back. A background child keeps it for its run.
  if (failed || open.nested)
    for (const childID of open.bound) {
      if (open.started.includes(childID)) continue
      const paid = next.prepaid.get(childID)
      if (paid?.admission === id) {
        const prepaid = new Map(next.prepaid)
        prepaid.delete(childID)
        next = give({ ...next, prepaid }, paid.from, 1 + paid.spare)
      }
      if (failed) released += 1
    }
  if (open.counted && (unbound > 0 || released > 0)) {
    const request = requestOf(next, open.requestID)
    next = withRequest(next, open.requestID, {
      ...request,
      pending: Math.max(0, request.pending - unbound),
      launched: Math.max(0, request.launched - released),
    })
  }
  return next
}

type Ticket =
  | { readonly kind: "held" }
  | { readonly kind: "queued" | "joined"; readonly id: number; readonly deferred: Deferred.Deferred<void> }

function enter(pool: Pool, i: RunInput, id: number): readonly [Ticket, Pool] {
  const open = new Map(pool.open)
  pool.open.forEach((entry, key) => {
    if (entry.bound.includes(i.childID) && !entry.started.includes(i.childID))
      open.set(key, { ...entry, started: [...entry.started, i.childID] })
  })
  const next: Pool = { ...pool, open }
  const holder = next.held.get(i.childID)
  if (holder)
    return [
      { kind: "held" },
      { ...next, held: new Map(next.held).set(i.childID, { ...holder, depth: holder.depth + 1 }) },
    ]
  const waiting = next.queue.find((waiter) => waiter.childID === i.childID)
  if (waiting)
    return [
      { kind: "joined", id: waiting.id, deferred: waiting.deferred },
      {
        ...next,
        queue: next.queue.map((waiter) => (waiter === waiting ? { ...waiter, parties: waiter.parties + 1 } : waiter)),
      },
    ]
  const paid = next.prepaid.get(i.childID)
  if (paid) {
    const prepaid = new Map(next.prepaid)
    prepaid.delete(i.childID)
    return [
      { kind: "held" },
      {
        ...next,
        prepaid,
        held: new Map(next.held).set(i.childID, { spare: paid.spare, from: paid.from, depth: 1 }),
      },
    ]
  }
  const spare = next.reserves.get(i.childID) ?? 0
  const reserves = new Map(next.reserves)
  reserves.delete(i.childID)
  if (!ahead(next, i.origin) && fits(next, i.origin, 1 + spare))
    return [{ kind: "held" }, { ...next, reserves, held: new Map(next.held).set(i.childID, { spare, depth: 1 }) }]
  const deferred = Deferred.makeUnsafe<void>()
  const waiter: Waiter = { id, childID: i.childID, origin: i.origin, spare, parties: 1, deferred }
  return [
    { kind: "queued", id, deferred },
    { ...next, reserves, queue: [...next.queue, waiter] },
  ]
}

function left(pool: Pool, childID: string): Pool {
  const holder = pool.held.get(childID)
  if (!holder) return pool
  const held = new Map(pool.held)
  if (holder.depth > 1) return { ...pool, held: held.set(childID, { ...holder, depth: holder.depth - 1 }) }
  held.delete(childID)
  return give({ ...pool, held }, holder.from, 1 + holder.spare)
}

// A party that stops waiting leaves the queue; one already granted its slot passes it on.
function cancelled(pool: Pool, id: number, childID: string): Pool {
  const waiter = pool.queue.find((item) => item.id === id)
  if (!waiter) return left(pool, childID)
  if (waiter.parties > 1)
    return {
      ...pool,
      queue: pool.queue.map((item) => (item === waiter ? { ...item, parties: item.parties - 1 } : item)),
    }
  return { ...pool, queue: pool.queue.filter((item) => item !== waiter) }
}

const idle = (pool: Pool) =>
  pool.held.size === 0 && pool.prepaid.size === 0 && pool.open.size === 0 && pool.queue.length === 0

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const guests = yield* FreeModelGuests.Service
    const guard = yield* SpendGuard.Service
    const pools = yield* Ref.make(new Map<string, SynchronizedRef.SynchronizedRef<Pool>>())
    const admissions = new WeakMap<Admission, { pool: SynchronizedRef.SynchronizedRef<Pool>; id: number }>()
    let ids = 0

    // The conversation's pool, the most recently used last. Idle pools past POOLS are dropped, oldest first.
    const poolOf = (conversationID: string) =>
      Ref.modify(pools, (current) => {
        const next = new Map(current)
        const pool = next.get(conversationID) ?? SynchronizedRef.makeUnsafe(EMPTY)
        next.delete(conversationID)
        next.set(conversationID, pool)
        for (const [key, ref] of next) {
          if (next.size <= POOLS) break
          if (key !== conversationID && idle(SynchronizedRef.getUnsafe(ref))) next.delete(key)
        }
        return [pool, next] as const
      })

    // Every pool change runs uninterruptibly: an interrupt while taking the ref's permit must not leave it taken.
    const change = <B>(pool: SynchronizedRef.SynchronizedRef<Pool>, f: (current: Pool) => readonly [B, Pool]) =>
      Effect.uninterruptible(SynchronizedRef.modify(pool, f))
    const wake = (woken: readonly Deferred.Deferred<void>[]) =>
      Effect.forEach(woken, (deferred) => Deferred.succeed(deferred, undefined), { discard: true })
    const settle = (pool: SynchronizedRef.SynchronizedRef<Pool>, f: (current: Pool) => Pool) =>
      change(pool, (current) => {
        const [next, woken] = drain(f(current))
        return [woken, next] as const
      }).pipe(Effect.flatMap(wake), Effect.uninterruptible)

    // The request's children at depth 1 and 2 below the conversation's roots, by the request id in their record
    // (SubagentLifecycle.METADATA_KEY is "subagent"). A child's subagent_cost already holds its own children's spend,
    // and workflow agents count against their run, not the request. Stored unpriced counts include Codium; the
    // delegated guard keeps Codium separate so only unknown own-key work consumes its unpriced-step allowance.
    const query = (conversationID: string, requestID: string) =>
      db
        .all<{ launched: number | null; spent: number | null; unpriced: number | null; codium: number | null }>(
          sql`WITH roots(id) AS (
            SELECT id FROM session WHERE id = ${conversationID}
            UNION
            SELECT id FROM session
            WHERE parent_id IS NULL
              AND project_id = (SELECT project_id FROM session WHERE id = ${conversationID})
              AND json_extract(metadata, '$.vector.kind') = 'parallel-agent'
              AND json_extract(metadata, '$.vector.parentSessionId') = ${conversationID}
          ),
          depth1 AS (
            SELECT id, cost + subagent_cost AS spent,
              unpriced_steps + subagent_unpriced_steps - codium_steps - subagent_codium_steps AS unpriced,
              codium_steps + subagent_codium_steps AS codium,
              json_extract(metadata, '$.subagent.requestID') AS request
            FROM session WHERE parent_id IN (SELECT id FROM roots)
          ),
          depth2 AS (
            SELECT child.cost + child.subagent_cost AS spent,
              child.unpriced_steps + child.subagent_unpriced_steps - child.codium_steps - child.subagent_codium_steps AS unpriced,
              child.codium_steps + child.subagent_codium_steps AS codium,
              json_extract(child.metadata, '$.subagent.requestID') AS request,
              json_extract(child.metadata, '$.subagent.workflow.role') AS role,
              depth1.request AS parent
            FROM session AS child JOIN depth1 ON child.parent_id = depth1.id
          )
          SELECT
            (SELECT count(*) FROM depth1 WHERE request = ${requestID})
              + (SELECT count(*) FROM depth2 WHERE request = ${requestID} AND role IS NOT 'agent') AS launched,
            (SELECT coalesce(sum(spent), 0) FROM depth1 WHERE request = ${requestID})
              + (SELECT coalesce(sum(spent), 0) FROM depth2 WHERE request = ${requestID} AND parent IS NOT ${requestID}) AS spent,
            (SELECT coalesce(sum(unpriced), 0) FROM depth1 WHERE request = ${requestID})
              + (SELECT coalesce(sum(unpriced), 0) FROM depth2 WHERE request = ${requestID} AND parent IS NOT ${requestID}) AS unpriced,
            (SELECT coalesce(sum(codium), 0) FROM depth1 WHERE request = ${requestID})
              + (SELECT coalesce(sum(codium), 0) FROM depth2 WHERE request = ${requestID} AND parent IS NOT ${requestID}) AS codium`,
        )
        .pipe(
          Effect.map((rows) => {
            const row = rows[0]
            return {
              launched: Number(row?.launched ?? 0),
              // The database keeps no step counts, so a restart starts the step count again at 0.
              seed: {
                spentUsd: Number(row?.spent ?? 0),
                steps: 0,
                unpricedSteps: Number(row?.unpriced ?? 0),
                codiumSteps: Number(row?.codium ?? 0),
              },
            }
          }),
          // Undefined when the count could not be read: nothing is kept, so the next call reads it again.
          Effect.catchCause((cause) =>
            Effect.logWarning("TaskLimits.seed: counting the request's subagents failed", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        )

    // Runs `f` on the pool with the request counted from the database first, once per key while it is kept. When the
    // count cannot be read, `f` sees a request with nothing counted that is not kept, and `seeded` is false.
    const withSeed = <B>(
      pool: SynchronizedRef.SynchronizedRef<Pool>,
      conversationID: string,
      requestID: string,
      f: (current: Pool, request: Request) => readonly [B, Pool],
    ) =>
      Effect.uninterruptible(
        SynchronizedRef.modifyEffect(pool, (current): Effect.Effect<readonly [Seeded<B>, Pool]> => {
          const run = (from: Pool, request: Request, seeded: boolean) => {
            const [value, next] = f(from, request)
            return [{ value, seeded }, next] as const
          }
          const found = current.requests.get(requestID)
          if (found) return Effect.succeed(run(current, found, true))
          return query(conversationID, requestID).pipe(
            Effect.map((counted) => {
              if (!counted) return run(current, { launched: 0, pending: 0, seed: NONE }, false)
              const request = { launched: counted.launched, pending: 0, seed: counted.seed }
              return run(withRequest(current, requestID, request), request, true)
            }),
          )
        }),
      )

    const seed = Effect.fn("TaskLimits.seed")(function* (conversationID: string, requestID: string) {
      const pool = yield* poolOf(conversationID)
      return (yield* withSeed(pool, conversationID, requestID, (current, request) => [request.seed, current] as const))
        .value
    })

    const capacity = Effect.fn("TaskLimits.capacity")(function* (i: {
      conversationID: string
      requestID: string
      limits: Limits
      need: number
    }) {
      const pool = yield* poolOf(i.conversationID)
      const checked = yield* withSeed(pool, i.conversationID, i.requestID, (current, request) => {
        const left = Math.max(0, i.limits.perRequest - request.launched - request.pending)
        const [next, woken] = limited(current, i.limits)
        return [{ refused: i.need > left ? batch(i.need, left) : undefined, woken }, next] as const
      })
      yield* wake(checked.value.woken)
      if (!checked.seeded) return yield* Effect.fail(unavailable())
      if (checked.value.refused) return yield* Effect.fail(checked.value.refused)
    })

    const admit = Effect.fn("TaskLimits.admit")(function* (i: AdmitInput) {
      const pool = yield* poolOf(i.conversationID)
      // The checks in order: the request's total, the delegated spend, then slots with the place taken atomically.
      const counted = yield* withSeed(
        pool,
        i.conversationID,
        i.requestID,
        (current, request) => [request, current] as const,
      )
      // A count that could not be read is never taken for none: the launch is refused, and the next one reads it again.
      if (!counted.seeded) return yield* Effect.fail(unavailable())
      const request = counted.value
      if (counts(i.origin) && request.launched + request.pending + i.count > i.limits.perRequest)
        return yield* Effect.fail(perRequest(request.launched + request.pending, i.limits.perRequest))
      // The ledger is re-armed with the current budget first, so a raised budget.subagents.usd admits again.
      const ledgerNow = yield* guard.rearm(i.conversationID as SessionID, {
        id: ledger(i.conversationID, i.requestID),
        budget: i.limits.budget,
        seed: request.seed,
      })
      if (ledgerNow.stopped)
        return yield* Effect.fail(spend(ledgerNow.spentUsd, ledgerNow.budget.usd ?? i.limits.budget.usd ?? 0))
      const id = ++ids
      const placed = yield* Effect.acquireRelease(
        change(pool, (current) => {
          // Waiters a raised running limit now has room for start first: they were there before this launch.
          const [ready, woken] = limited(current, i.limits)
          const [result, next] = place(ready, i, id)
          return [{ result, woken }, next] as const
        }).pipe(
          Effect.tap(({ woken }) => wake(woken)),
          Effect.map(({ result }) => result),
        ),
        (result, exit) =>
          "admission" in result ? settle(pool, (current) => closed(current, id, Exit.isFailure(exit))) : Effect.void,
      )
      if ("refused" in placed) return yield* Effect.fail(placed.refused)
      admissions.set(placed.admission, { pool, id })
      return placed.admission
    })

    const bind = Effect.fn("TaskLimits.bind")(function* (admission: Admission, childID: SessionID) {
      const found = admissions.get(admission)
      if (!found) return
      yield* settle(found.pool, (current) => bound(current, found.id, childID))
    })

    const release = Effect.fn("TaskLimits.release")(function* (admission: Admission, childID: SessionID) {
      const found = admissions.get(admission)
      if (!found) return
      yield* settle(found.pool, (current) => unstarted(current, found.id, childID))
    })

    const run = <A, E, R>(i: RunInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const pool = yield* poolOf(i.conversationID)
          const ticket = yield* change(pool, (current) => enter(current, i, ++ids))
          if (ticket.kind !== "held") {
            const wait = Effect.gen(function* () {
              if (ticket.kind === "queued" && i.waiting) yield* i.waiting
              yield* Deferred.await(ticket.deferred)
            })
            yield* restore(wait).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? settle(pool, (current) => cancelled(current, ticket.id, i.childID))
                  : Effect.void,
              ),
            )
          }
          return yield* restore(effect).pipe(Effect.ensuring(settle(pool, (current) => left(current, i.childID))))
        }),
      )

    const status = Effect.fn("TaskLimits.status")(function* (
      conversationID: string,
      requestID?: string,
      limits?: Limits,
    ) {
      const pool = yield* poolOf(conversationID)
      const read = (current: Pool, request?: Request) => {
        const [next, woken] = limited(current, limits)
        return [{ pool: next, request, woken }, next] as const
      }
      const { pool: current, request, woken } = requestID
        ? (yield* withSeed(pool, conversationID, requestID, read)).value
        : yield* change(pool, (value) => read(value))
      yield* wake(woken)
      // Before any launch in this process, the defaults, held to the guest limits for a guest's conversation.
      const effective = limits ?? current.limits ?? resolve({}, yield* guests.marked(conversationID as SessionID))
      const result: Status = {
        running: current.held.size,
        queued: current.queue.length,
        limit: effective.running,
        launched: request ? request.launched + request.pending : 0,
        perRequest: effective.perRequest,
      }
      if (!requestID || !request) return result
      const snapshot = yield* guard.delegated(ledger(conversationID, requestID))
      const budget = snapshot?.budget ?? effective.budget
      const spentUsd = snapshot?.spentUsd ?? request.seed.spentUsd
      const limitUsd = budget.usd
      const warn = limitUsd !== undefined && spentUsd >= limitUsd * (budget.warnAt ?? SpendGuard.WARN_AT)
      return {
        ...result,
        spend: {
          spentUsd,
          ...(limitUsd !== undefined && { limitUsd }),
          unknownSteps: snapshot?.unpricedSteps ?? request.seed.unpricedSteps,
          warned: warn,
          stopped: snapshot ? snapshot.stopped !== undefined : limitUsd !== undefined && spentUsd >= limitUsd,
        },
      }
    })

    // The request each root's prompt loop last counted launches in, the most recently recorded last.
    const requests = yield* Ref.make(new Map<string, string>())
    const track = Effect.fn("TaskLimits.track")(function* (rootID: string, requestID: string) {
      yield* Ref.update(requests, (current) => {
        if (current.get(rootID) === requestID) return current
        const next = new Map(current)
        next.delete(rootID)
        next.set(rootID, requestID)
        for (const key of next.keys()) {
          if (next.size <= POOLS) break
          next.delete(key)
        }
        return next
      })
    })
    const tracked = (rootID: string) => Ref.get(requests).pipe(Effect.map((current) => current.get(rootID)))

    return Service.of({ capacity, admit, bind, release, run, status, seed, track, tracked })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, FreeModelGuests.node, SpendGuard.node],
})
