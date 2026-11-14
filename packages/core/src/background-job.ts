export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Schema, Scope, SynchronizedRef } from "effect"
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/app-node"
import type { BackgroundJobStore } from "./background-job-store"

/** `interrupted`: stopped because its instance or Vector itself was going away, not because anyone asked. */
export type Status = "running" | "completed" | "error" | "cancelled" | "interrupted"

/**
 * A run that failed but still produced output worth keeping, such as a subagent whose provider failed partway through
 * its answer. The job settles as an error and keeps the output.
 */
export class RunFailed extends Schema.TaggedErrorClass<RunFailed>()("BackgroundJob.RunFailed", {
  message: Schema.String,
  output: Schema.String,
}) {}

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  /** What the last run wrote. */
  output?: string
  /** What every run wrote, in the order the runs were added, when the job ran more than once. */
  outputs?: string[]
  error?: string
  metadata?: Record<string, unknown>
  /** The instance lease running a durable job (`BackgroundJobStore.Owner.runtime`). */
  owner?: string
  /** Whether the job keeps a row in vector.db, so a restart can tell its parent it was interrupted. */
  durable?: boolean
}

/** What a durable job's row holds beside the job itself. Metadata stays under 4 KiB and is never a brief or output. */
export type Durable = {
  parentSessionID: string
  sessionID?: string
  directory: string
  attempt?: number
  metadata?: Record<string, unknown>
}

/** The lease and attempt a row write is for: a write naming another lease or attempt changes nothing. */
export type Holder = { owner: string; attempt?: number }

export type Started = Durable & {
  id: string
  type: string
  title?: string
  background: boolean
  startedAt: number
  owner: BackgroundJobStore.Owner
}

export type Settled = Holder & { status: Exclude<Status, "running">; completedAt: number; error?: string }

export type MetadataUpdated = Holder & { metadata: Record<string, unknown> }

/** `background` belongs to promote(), and cannot be changed by a metadata patch. */
export type MetadataUpdate = Holder & { patch: Record<string, unknown> }

/** Where durable jobs keep their rows (BackgroundJobStore). */
export interface Store {
  readonly started: (row: Started) => Effect.Effect<void, unknown>
  readonly settled: (id: string, p: Settled) => Effect.Effect<void, unknown>
  readonly promoted: (id: string, p: Holder) => Effect.Effect<void, unknown>
  /** Run the bounded, database-free publication at commit, before acknowledgement can be interrupted or delayed. */
  readonly metadataUpdated: (
    id: string,
    p: MetadataUpdated,
    publish?: Effect.Effect<void>,
  ) => Effect.Effect<boolean, unknown>
  /** Marks the lease's running rows as still held at `at` (a heartbeat). */
  readonly heartbeat?: (owner: string, at: number) => Effect.Effect<void, unknown>
}

/** How often a registry refreshes its running durable rows, so other engines can tell it is alive (milliseconds). */
export const HEARTBEAT = 60_000

// A durable job's row writes, in order: each waits for the one before it, so a settlement never lands before the row.
type Writes = {
  holder: Holder
  tail?: Deferred.Deferred<void>
  started: boolean
  metadata: Record<string, unknown>
}

// Cooperative deadline including the earlier-write/connection wait. A synchronous SQLite busy wait can still take
// its configured 5 seconds; native commit and short in-memory publication cannot be interrupted halfway through.
const STORE_TIMEOUT = "2 seconds"

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  // Every run has returned and run its finalizers; released before the completion callback.
  ran: Deferred.Deferred<void>
  // `ran`, then the completion callback too.
  drained: Deferred.Deferred<void>
  fibers: number
  token: object
  pending: number
  next: number
  outputs: { sequence: number; text: string }[]
  // How the latest run added so far ended, which is how the job ends.
  last?: { sequence: number; exit: Exit.Exit<string, unknown> }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
  onComplete?: (info: Info) => Effect.Effect<void, unknown>
  promotable: boolean
  durable?: Writes
  metadataWrites: { closed: boolean; pending: Set<Deferred.Deferred<void>> }
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  ran?: Deferred.Deferred<void>
  drained?: Deferred.Deferred<void>
  scope?: Scope.Closeable
  durable?: Writes
  onComplete?: (info: Info) => Effect.Effect<void, unknown>
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
  durable?: Writes
}

type StartResult =
  | { info: Info }
  | { info: Info; scope: Scope.Closeable; token: object; durable?: Writes }
  | { closing: Deferred.Deferred<Info> }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  /**
   * Runs once after every joined run has drained, before completion waiters are released. A cancel that stops the job
   * waits for it; a cancel that reaches a job already ended on its own does not.
   */
  onComplete?: (info: Info) => Effect.Effect<void, unknown>
  promotable?: boolean
  /** Keep a row for the job, when the registry has a store and a lease. */
  durable?: Durable
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
  /**
   * Start now, alongside the run already going, instead of after it. The job still settles only once every run has
   * returned.
   */
  concurrent?: boolean
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  /**
   * Patches a live durable incarnation, including its cancellation finalizers, before it drains. Both metadata
   * snapshots must be JSON objects within 4 KiB; a promotable job also reserves room for background:true in memory.
   * Admission commits the bounded write independently of caller interruption. False leaves both snapshots unchanged.
   */
  readonly updateMetadata: (id: string, input: MetadataUpdate) => Effect.Effect<boolean>
  /** The instance lease this registry's durable jobs run under, if it has one. */
  readonly lease: () => Effect.Effect<BackgroundJobStore.Owner | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: metadataSnapshot(job.info.metadata) ?? { ...job.info.metadata } } : {}),
    ...(job.info.outputs ? { outputs: [...job.info.outputs] } : {}),
  }
}

/** @internal A detached, bounded JSON object. Invalid fields are refused, never silently dropped or truncated. */
export function metadataSnapshot(input: unknown): Record<string, unknown> | undefined {
  const active = new Set<object>()
  let remaining = 4096
  const copy = (value: unknown): unknown => {
    if (--remaining < 0) return
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined
    if (typeof value === "string") return value.length <= 4096 ? value : undefined
    if (typeof value !== "object" || active.has(value)) return
    const array = Array.isArray(value)
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![null, Object.prototype].includes(Object.getPrototypeOf(value))
    )
      return
    const length: unknown = array ? Object.getOwnPropertyDescriptor(value, "length")?.value : 0
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 4096) return
    const keys = Reflect.ownKeys(value)
    if (keys.length > 4096 || (array && keys.length !== length + 1)) return
    const output: object = array ? [] : Object.create(null)
    active.add(value)
    for (const key of keys) {
      if (array && key === "length") continue
      if (typeof key !== "string" || key.length > 4096) return
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (!property?.enumerable || !("value" in property)) return
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return
      const copied = copy(property.value)
      if (copied === undefined) return
      Object.defineProperty(output, key, { value: copied, enumerable: true })
    }
    active.delete(value)
    return output
  }
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return
    const detached = copy(input)
    if (detached === undefined) return
    const text = JSON.stringify(detached)
    if (new TextEncoder().encode(text).length > 4096) return
    return JSON.parse(text)
  } catch {
    return
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Closing its scope interrupts live work, and the registry itself forgets
 * it. A job started with `durable` also keeps a row through `store`, under the registry's `owner` lease, so a later
 * process can tell what a restart interrupted. While `disposing()` holds, work that stops is `interrupted`, not
 * `cancelled`. Row writes run outside the registry's lock, within STORE_TIMEOUT; a failure is logged, never the job's.
 */
export const makeWith = Effect.fnUntraced(function* (o: {
  store?: Store
  owner?: BackgroundJobStore.Owner
  disposing?: () => boolean
}) {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }
  const stopped = (): "cancelled" | "interrupted" => (o.disposing?.() ? "interrupted" : "cancelled")
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const jobs = [...(yield* SynchronizedRef.get(state.jobs)).values()]
      yield* Effect.forEach(
        jobs,
        (job) =>
          Scope.close(job.scope, Exit.void).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("background job cleanup failed", { id: job.info.id, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )
      yield* Effect.forEach(jobs, (job) => Deferred.await(job.drained), { concurrency: "unbounded", discard: true })
      yield* Effect.forEach(jobs, (job) => (job.durable?.tail ? Deferred.await(job.durable.tail) : Effect.void), {
        concurrency: "unbounded",
        discard: true,
      })
    }),
  )

  // Queues a row write behind the job's earlier ones; the caller runs it, or forks it so nothing waits on the store.
  const write = (writes: Writes, id: string, call: (store: Store) => Effect.Effect<void, unknown>) => {
    const previous = writes.tail
    const done = Deferred.makeUnsafe<void>()
    writes.tail = done
    return (previous ? Deferred.await(previous) : Effect.void).pipe(
      Effect.andThen(Effect.suspend(() => (o.store ? call(o.store) : Effect.void))),
      Effect.timeout(STORE_TIMEOUT),
      Effect.catchCause((cause) => Effect.logWarning("background job row was not written", { id, cause })),
      Effect.ensuring(Deferred.succeed(done, undefined)),
    )
  }
  const settled = (writes: Writes, info: Info) =>
    write(writes, info.id, (store) =>
      store.settled(info.id, {
        ...writes.holder,
        status: info.status === "running" ? "cancelled" : info.status,
        completedAt: info.completed_at ?? info.started_at,
        ...(info.error ? { error: info.error } : {}),
      }),
    )
  const detach = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.forkDetach({ startImmediately: true }))

  const updateMetadata: Interface["updateMetadata"] = Effect.fn("BackgroundJob.updateMetadata")(function* (id, input) {
    const patch = metadataSnapshot(input.patch)
    if (!patch || Object.hasOwn(patch, "background")) return false
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>()
        const result = yield* Deferred.make<boolean>()
        const admitted = yield* SynchronizedRef.modify(state.jobs, (jobs) => {
          const job = jobs.get(id)
          const writes = job?.durable
          if (
            !job ||
            !writes ||
            job.metadataWrites.closed ||
            writes.holder.owner !== input.owner ||
            writes.holder.attempt !== input.attempt
          )
            return [undefined, jobs] as const
          const previous = writes.tail
          writes.tail = done
          job.metadataWrites.pending.add(done)
          return [{ token: job.token, writes, previous }, jobs] as const
        })
        if (!admitted) return false
        let committed = false
        const operation = Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            if (admitted.previous) yield* resume(Deferred.await(admitted.previous))
            // Build from the last accepted snapshots, not from a failed patch or an earlier queued caller's view.
            const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
            if (!job || job.token !== admitted.token || !admitted.writes.started || !o.store) return false
            const base = metadataSnapshot(job.info.metadata ?? {})
            if (!base) return false
            const memory = metadataSnapshot({ ...base, ...patch })
            const durable = metadataSnapshot({ ...admitted.writes.metadata, ...patch })
            if (!memory || !durable) return false
            if (job.promotable && job.info.status === "running" && !metadataSnapshot({ ...memory, background: true }))
              return false
            // The store invokes this at commit, before acknowledgement. The pending barrier prevents drain and id
            // reuse; only promote() can have changed metadata meanwhile, and its registry-owned flag wins.
            const publish = SynchronizedRef.modify(state.jobs, (jobs) => {
              const current = jobs.get(id)
              if (!current || current.token !== admitted.token) return [false, jobs] as const
              admitted.writes.metadata = durable
              committed = true
              return [
                true,
                new Map(jobs).set(id, {
                  ...current,
                  info: {
                    ...current.info,
                    metadata: {
                      ...memory,
                      ...(current.info.metadata?.background === true ? { background: true } : {}),
                    },
                  },
                }),
              ] as const
            }).pipe(Effect.asVoid)
            yield* resume(
              o.store.metadataUpdated(
                id,
                {
                  ...admitted.writes.holder,
                  metadata: durable,
                },
                publish,
              ),
            )
            return committed
          }),
        ).pipe(
          Effect.interruptible,
          Effect.timeout(STORE_TIMEOUT),
          Effect.catchCause((cause) =>
            committed
              ? Effect.succeed(true)
              : Effect.logWarning("background job metadata was not written", { id, cause }).pipe(Effect.as(false)),
          ),
          Effect.tap((accepted) => Deferred.succeed(result, accepted)),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* SynchronizedRef.modify(state.jobs, (jobs) => {
                const job = jobs.get(id)
                if (job?.token === admitted.token) job.metadataWrites.pending.delete(done)
                return [undefined, jobs] as const
              })
              yield* Deferred.succeed(done, undefined)
            }),
          ),
        )
        // A caller can stop waiting, but cannot strand an admitted write or interrupt between commit/publication.
        yield* detach(operation)
        return yield* restore(Deferred.await(result))
      }),
    )
  })

  const metadataBarrier = Effect.fn("BackgroundJob.metadataBarrier")(function* (
    id: string,
    token: object,
    close: boolean,
  ) {
    while (true) {
      const result = yield* SynchronizedRef.modifyEffect(
        state.jobs,
        Effect.fnUntraced(function* (jobs): Effect.fn.Return<
          readonly [{ info: Info | undefined; pending: Deferred.Deferred<void>[] }, Map<string, Active>]
        > {
          const job = jobs.get(id)
          if (!job || job.token !== token) return [{ info: undefined, pending: [] }, jobs] as const
          // Run and completion finalizers have returned. Seal admission before joining their remaining writes.
          if (close) job.metadataWrites.closed = true
          const pending = [...job.metadataWrites.pending]
          if (pending.length) return [{ info: undefined, pending }, jobs] as const
          const info = snapshot(job)
          if (close) {
            yield* Deferred.succeed(job.done, info)
            yield* Deferred.succeed(job.drained, undefined)
          }
          return [{ info, pending }, jobs] as const
        }),
      )
      if (!result.pending.length) return result.info
      yield* Effect.forEach(result.pending, (done) => Deferred.await(done), { concurrency: "unbounded", discard: true })
      if (!close) {
        const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
        return job?.token === token ? snapshot(job) : undefined
      }
    }
  })

  // While a durable job runs, its rows' heartbeat is refreshed every minute: a pid that answers may belong to another
  // process by now (Windows reuses them quickly), and a heartbeat that stopped tells other engines the lease is gone.
  const beat = o.store?.heartbeat
  const runtime = o.owner?.runtime
  if (beat && runtime)
    yield* Effect.sleep(HEARTBEAT).pipe(
      Effect.andThen(SynchronizedRef.get(state.jobs)),
      Effect.flatMap((jobs) =>
        [...jobs.values()].some((job) => job.durable && job.info.status === "running")
          ? Effect.suspend(() => beat(runtime, Date.now())).pipe(
              Effect.timeout(STORE_TIMEOUT),
              Effect.catchCause((cause) => Effect.logWarning("background job heartbeat was not written", { cause })),
            )
          : Effect.void,
      ),
      Effect.forever,
      Effect.forkIn(state.scope, { startImmediately: true }),
    )

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const failed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      // Every run's output is kept: a run added to a job reports on top of the ones before it, not instead of them.
      const text = Exit.isSuccess(exit) ? exit.value : failed instanceof RunFailed ? failed.output : undefined
      const outputs = (text === undefined ? job.outputs : [...job.outputs, { sequence, text }]).toSorted(
        (a, b) => a.sequence - b.sequence,
      )
      const last = !job.last || sequence > job.last.sequence ? { sequence, exit } : job.last
      // A run that fails leaves the runs added to the job to finish: a follow-up sent to a subagent whose provider
      // failed is often what recovers it, and one that failed alongside a running run must not stop that run. The job
      // settles once every run has returned, as the latest run added ended, whichever returned last.
      if (pending > 0) return [{}, new Map(jobs).set(id, { ...job, pending, outputs, last })]
      const final = last.exit
      const status: Exclude<Status, "running"> = Exit.isSuccess(final)
        ? "completed"
        : Cause.hasInterruptsOnly(final.cause)
          ? stopped()
          : "error"
      const output = outputs.at(-1)
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        outputs,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(outputs.length > 1 ? { outputs: outputs.map((item) => item.text) } : {}),
          ...(status === "error" && Exit.isFailure(final) ? { error: errorText(Cause.squash(final.cause)) } : {}),
        },
      }
      return [{ info: snapshot(next), scope: job.scope, durable: job.durable }, new Map(jobs).set(id, next)]
    })
    if (result.scope && result.scope.state._tag !== "Closed") {
      // A run cannot join its own closing scope. The registry finalizer above joins the drain even when disposal
      // races this closer, so it is safe to launch the close outside a possibly already closing registry scope.
      yield* detach(Scope.close(result.scope, Exit.void))
    }
    // Row writes never block job completion. The registry finalizer joins their bounded tails on disposal.
    if (result.info && result.durable) yield* detach(settled(result.durable, result.info))
    return result.info
  })

  // Scope.close marks its scope Closed before its fibers finish finalizers. Completion has its own barrier,
  // reached only after every run's full onExit, so another canceller cannot mistake that marker for a join.
  const finished = Effect.fn("BackgroundJob.finished")(function* (id: string, token: object) {
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job || job.token !== token) return [{}, jobs]
      const next = {
        ...job,
        fibers: job.fibers - 1,
        ...(job.fibers === 1 ? { onComplete: undefined } : {}),
      }
      return [
        next.fibers === 0
          ? { info: snapshot(next), done: next.done, ran: next.ran, drained: next.drained, onComplete: job.onComplete }
          : {},
        new Map(jobs).set(id, next),
      ]
    })
    if (result.ran) yield* Deferred.succeed(result.ran, undefined)
    const complete = result.onComplete
    const info = result.info ? yield* metadataBarrier(id, token, false) : undefined
    yield* (
      info && complete
        ? Effect.suspend(() => complete(info)).pipe(
            Effect.catchCause((cause) => Effect.logWarning("background job completion callback failed", { id, cause })),
          )
        : Effect.void
    ).pipe(Effect.ensuring(result.info ? metadataBarrier(id, token, true).pipe(Effect.asVoid) : Effect.void))
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
  ) {
    // onExit, not a match on the result: closing the job's scope from outside, as disposing the instance does,
    // interrupts this fiber, and only a finalizer still settles the job, completes its waiters and records how it ended.
    return yield* Effect.suspend(() =>
      scope.state._tag === "Closed" || state.scope.state._tag === "Closed" ? Effect.interrupt : run,
    ).pipe(
      Effect.onExit((exit) => settle(id, token, sequence, exit).pipe(Effect.ensuring(finished(id, token)))),
      Effect.ignore,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return Array.from((yield* SynchronizedRef.get(state.jobs)).values())
      .map(snapshot)
      .toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (state.scope.state._tag === "Closed") return yield* Effect.interrupt
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const row: Started | undefined =
          input.durable && o.store && o.owner
            ? {
                ...input.durable,
                metadata: input.durable.metadata === undefined ? undefined : metadataSnapshot(input.durable.metadata),
                id,
                type: input.type,
                ...(input.title === undefined ? {} : { title: input.title }),
                background: input.metadata?.background === true,
                startedAt: started_at,
                owner: o.owner,
              }
            : undefined
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            if (state.scope.state._tag === "Closed") return yield* Effect.interrupt
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            if (existing && !Deferred.isDoneUnsafe(existing.done))
              return [{ closing: existing.done }, jobs] as readonly [StartResult, Map<string, Active>]
            const scope = yield* Scope.fork(state.scope, "parallel")
            if (scope.state._tag === "Closed") return yield* Effect.interrupt
            const token = {}
            const ran = yield* Deferred.make<void>()
            const drained = yield* Deferred.make<void>()
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: metadataSnapshot(input.metadata) ?? input.metadata,
                ...(row ? { owner: row.owner.runtime, durable: true } : {}),
              },
              done,
              scope,
              ran,
              drained,
              fibers: 1,
              token,
              pending: 1,
              next: 1,
              outputs: [],
              tail,
              promoted,
              onPromote: input.onPromote,
              onComplete: input.onComplete,
              promotable: input.promotable !== false,
              metadataWrites: { closed: false, pending: new Set<Deferred.Deferred<void>>() },
              // A job started again under its id writes after the writes its previous run left queued.
              durable: row
                ? {
                    holder: { owner: row.owner.runtime, attempt: row.attempt },
                    tail: existing?.durable?.tail,
                    started: false,
                    metadata: row.metadata ?? {},
                  }
                : undefined,
            }
            return [
              { info: snapshot(job), scope, token, durable: job.durable },
              new Map(jobs).set(id, job),
            ] as readonly [StartResult, Map<string, Active>]
          }),
        )
        if ("closing" in result) {
          yield* restore(Deferred.await(result.closing))
          return yield* start(input)
        }
        // Queued before the run starts, so the row exists before any settlement of it is written.
        if ("scope" in result && row && result.durable) {
          const writes = result.durable
          yield* detach(
            write(writes, id, (store) =>
              store.started(row).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    writes.started = true
                  }),
                ),
              ),
            ),
          )
        }
        if ("scope" in result)
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
        return result.info
      }),
    )
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modify(
          state.jobs,
          (jobs): readonly [ExtendResult, Map<string, Active>] => {
            const job = jobs.get(input.id)
            if (
              !job ||
              job.info.status !== "running" ||
              job.scope.state._tag === "Closed" ||
              state.scope.state._tag === "Closed"
            )
              return [{ extended: false }, jobs]
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              new Map(jobs).set(input.id, {
                ...job,
                pending: job.pending + 1,
                fibers: job.fibers + 1,
                next: job.next + 1,
                // A concurrent run leaves the queue as it is, so a run queued later waits only on the queued ones.
                tail: input.concurrent ? job.tail : tail,
              }),
            ]
          },
        )
        if (!result.extended) return false
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          input.concurrent
            ? restore(input.run)
            : Deferred.await(result.previous).pipe(
                Effect.andThen(restore(input.run)),
                Effect.ensuring(Deferred.succeed(result.tail, undefined)),
              ),
        )
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (yield* Deferred.isDone(job.done)) return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    return yield* Deferred.await(job.promoted)
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.info.status !== "running" || !job.promotable)
          return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        return [
          { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted, durable: job.durable },
          new Map(jobs).set(id, next),
        ] as readonly [PromoteResult, Map<string, Active>]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    const durable = result.promoted && result.durable
    if (durable) yield* detach(write(durable, id, (store) => store.promoted(id, durable.holder)))
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      // A job that ended on its own is not stopped: the caller joins its runs, never its completion callback (a normal
      // end's save, which may run Git). A job a Stop ended is joined through its callback, which records that stop.
      if (job.info.status !== "running")
        return [
          {
            info: snapshot(job),
            drained: job.info.status === "completed" || job.info.status === "error" ? job.ran : job.drained,
          },
          jobs,
        ]
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        info: {
          ...job.info,
          status: stopped(),
          completed_at,
        },
      }
      return [
        { info: snapshot(next), drained: job.drained, scope: job.scope, durable: job.durable },
        new Map(jobs).set(id, next),
      ]
    })
    if (result.info && result.durable) yield* detach(settled(result.durable, result.info))
    if (result.scope) {
      // A Stop can run synchronously inside one of the job's own steps (its run completed a Deferred whose waiter stops
      // it). Closing the scope then interrupts that fiber re-entrantly: its finalizers and completion callback start
      // while the step is still on the stack, and the runtime hands that step's result to the callback's first pending
      // step. Interrupting from a fresh tick keeps the callback's results its own.
      yield* Effect.yieldNow
      yield* Scope.close(result.scope, Exit.void)
    }
    if (result.drained) yield* Deferred.await(result.drained)
    return result.info
  }, Effect.uninterruptible)

  const lease: Interface["lease"] = () => Effect.succeed(o.owner)

  return Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel, updateMetadata, lease })
})

/** A registry that keeps no rows. */
export const make = makeWith({})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
