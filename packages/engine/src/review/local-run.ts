import { createHash, randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Option, Result, Schema, Semaphore } from "effect"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { SessionTable } from "@vectordevai/core/session/sql"
import { decodeLocalResult } from "@vectordevai/core/review/local-result"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { PINNED_SESSION_PREFIX, VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { NonNegativeInt, optional } from "@vectordevai/schema/schema"
import { BackgroundJob } from "@/background/job"
import { EffectBridge } from "@/effect/bridge"
import type { LocalReviewDeps } from "@/cli/cmd/review"
import { Git } from "@/git"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ReviewLocalAdmission } from "./local-admission"
import { ReviewService } from "./service"
import { ReviewLifecycle } from "./lifecycle"

export const MARKER = `${PINNED_SESSION_PREFIX}run`
export const FIELD = "vectorscopeLocalRun"
export const JOB = "vectorscope-review"

export class Error extends Schema.TaggedErrorClass<Error>()("ReviewLocalRun.Error", {
  code: Schema.Literals(["invalid", "not_found", "conflict", "unavailable", "corrupt"]),
  message: Schema.String,
}) {}

const Stored = Schema.Struct({
  version: Schema.Literal(1),
  parentID: SessionID,
  request: ReviewRun.Start,
  directory: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "cancelled", "interrupted"]),
  startedAt: NonNegativeInt,
  completedAt: optional(NonNegativeInt),
  artifact: optional(ReviewRun.Artifact),
  error: optional(Schema.String.check(Schema.isMaxLength(2048))),
})
type Stored = typeof Stored.Type

export function readRecord(input: unknown) {
  const decoded = Schema.decodeUnknownOption(Stored, { onExcessProperty: "error" })(input)
  return Option.isSome(decoded) ? decoded.value : undefined
}

export interface Interface<R = never> {
  /** Called after the HTTP boundary establishes owner identity and session control. */
  readonly start: (
    request: unknown,
    source: ReviewLocalAdmission.Source,
  ) => Effect.Effect<ReviewRun.Info, Error | ReviewLocalAdmission.Refused, R | Git.Service>
  readonly get: (parentID: SessionID, runID: SessionID) => Effect.Effect<ReviewRun.Info, Error>
  readonly stop: (parentID: SessionID, runID: SessionID) => Effect.Effect<ReviewRun.Info, Error>
}

// One coordinator owns placement/lifecycle, not model execution. BackgroundJob
// owns its fiber/lease; the existing shared pipeline owns every model attempt,
// step, finalizer, selection and usage calculation. Nothing resumes paid work.
export const make = <RunR, ModelR>(pipeline: Pick<LocalReviewDeps<RunR, ModelR>, "runReview" | "resolveModel">) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* BackgroundJob.Service
    const store = yield* BackgroundJobStore.Service
    const database = yield* Database.Service
    const requests = yield* ReviewRequestStore.Service
    const lifecycle = yield* ReviewLifecycle.Service
    const lock = yield* Semaphore.make(1)
    const active = new Map<SessionID, { abort: AbortController; finished: boolean }>()

    const load = Effect.fn("ReviewLocalRun.load")(function* (parentID: SessionID, runID: SessionID) {
      const run = yield* sessions
        .get(runID)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Local review not found." })))
      if (run.parentID !== parentID || run.internal !== MARKER)
        return yield* new Error({ code: "not_found", message: "Local review not found." })
      const decoded = Schema.decodeUnknownOption(Stored, { onExcessProperty: "error" })(run.metadata?.[FIELD])
      if (Option.isNone(decoded) || decoded.value.parentID !== parentID)
        return yield* new Error({ code: "corrupt", message: "The saved local review record is invalid." })
      if (decoded.value.artifact && !validArtifact(decoded.value.artifact))
        return yield* new Error({ code: "corrupt", message: "The saved local review result is invalid." })
      if (decoded.value.artifact) {
        const value = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(decoded.value.artifact.json)
        if (Option.isNone(value) || !decodeLocalResult(value.value, decoded.value.request.target))
          return yield* new Error({ code: "corrupt", message: "The saved local review outcome is invalid." })
      }
      return { run, record: decoded.value }
    })
    const save = Effect.fn("ReviewLocalRun.save")(function* (runID: SessionID, record: Stored) {
      const run = yield* sessions
        .get(runID)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Local review not found." })))
      if (run.parentID !== record.parentID || run.internal !== MARKER)
        return yield* new Error({ code: "not_found", message: "Local review not found." })
      yield* sessions.setMetadata({ sessionID: runID, metadata: { ...run.metadata, [FIELD]: record } })
    })
    const owned = (job: BackgroundJob.Info, parentID: SessionID, runID: SessionID) =>
      job.id === runID && job.type === JOB && job.metadata?.parentSessionId === parentID
    const info = (runID: SessionID, record: Stored, canStop = false): ReviewRun.Info => ({
      runID,
      parentID: record.parentID,
      request: record.request,
      status: record.status,
      canStop,
      startedAt: record.startedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.artifact ? { artifact: record.artifact } : {}),
      ...(record.error ? { error: record.error } : {}),
    })

    const get: Interface["get"] = Effect.fn("ReviewLocalRun.get")(function* (parentID, runID) {
      const saved = yield* load(parentID, runID)
      const job = yield* jobs.get(runID)
      if (job) {
        if (!owned(job, parentID, runID))
          return yield* new Error({ code: "corrupt", message: "The local review job has a different owner." })
        if (job.status === "running") return info(runID, saved.record, true)
        // The completion callback persists the terminal state before releasing
        // waiters. A poll during that save remains in progress, never clean.
        const waited = yield* jobs.wait({ id: runID, timeout: 0 })
        if (waited.timedOut) return info(runID, saved.record)
        const latest = (yield* load(parentID, runID)).record
        return latest.status === "running"
          ? { ...info(runID, latest), status: "unknown", error: "The engine could not save the review's final status." }
          : info(runID, latest)
      }
      if (saved.record.status !== "running") return info(runID, saved.record)
      const row = (yield* store.forParent(parentID)).find((row) => row.id === runID)
      if (!row)
        return {
          ...info(runID, saved.record),
          status: "unknown",
          error: "The engine cannot establish this review's status. It will not restart it automatically.",
        }
      if (row.type !== JOB || row.sessionID !== runID || row.directory !== saved.record.directory)
        return yield* new Error({ code: "corrupt", message: "The local review lease has a different owner." })
      if (row.status === "running") {
        const liveness = BackgroundJobStore.liveness(row)
        if (liveness !== "dead")
          return {
            ...info(runID, saved.record),
            status: liveness === "alive" ? "running" : "unknown",
            error: "This engine does not own the review. It will not restart or stop it.",
          }
        // Claim only the exact dead lease/attempt. A process-local miss alone
        // never authorizes interrupting work another engine may still own.
        if (!(yield* store.claim(row, Date.now())))
          return { ...info(runID, saved.record), status: "unknown", error: "The review's lease changed." }
      }
      if (row.status === "interrupted" && row.reportedAt === undefined && !(yield* store.claim(row, Date.now())))
        return { ...info(runID, saved.record), status: "unknown", error: "The review's lease changed." }
      const record: Stored = {
        ...saved.record,
        status:
          row.status === "completed" && saved.record.artifact
            ? "completed"
            : row.status === "cancelled"
              ? "cancelled"
              : row.status === "error" || row.status === "completed"
                ? "failed"
                : "interrupted",
        completedAt: row.completedAt ?? Date.now(),
        ...(row.status === "running" || row.status === "interrupted"
          ? { error: "The engine stopped before this review finished. Start a new review to try again." }
          : row.status === "completed" && !saved.record.artifact
            ? { error: "The completed review's result is unavailable." }
            : {}),
      }
      yield* save(runID, record)
      return info(runID, record)
    })

    const start: Interface<RunR | ModelR>["start"] = Effect.fn("ReviewLocalRun.start")(function* (input, source) {
      const decoded = Schema.decodeUnknownOption(ReviewRun.Start, { onExcessProperty: "error" })(input)
      if (Option.isNone(decoded)) return yield* new Error({ code: "invalid", message: "Invalid local review request." })
      const request: ReviewRun.Start = { ...decoded.value, target: { ...decoded.value.target } }
      const requester = { ...source, permission: source.permission.map((rule) => ({ ...rule })) }
      // Admission freezes authority before any asynchronous session lookup.
      // A lost response can still join an exact existing run after HEAD moves;
      // it never creates another run from a stale request.
      const admission = yield* ReviewLocalAdmission.prepare(request, requester).pipe(Effect.result)
      if (Result.isFailure(admission) && admission.failure.code !== "stale") return yield* admission.failure
      const parentID = SessionID.make(requester.sessionID)
      // Query identifiers first: an exact retry must not hydrate every earlier
      // review's potentially large result JSON into the request's memory.
      const children = yield* database.db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.parent_id, parentID),
            eq(SessionTable.internal, MARKER),
            eq(
              sql<string>`json_extract(${SessionTable.metadata}, '$.vectorscopeLocalRun.request.requestID')`,
              request.requestID,
            ),
          ),
        )
        .limit(2)
        .all()
        .pipe(Effect.orDie)
      const matching = yield* Effect.forEach(children, (child) => load(parentID, SessionID.make(child.id)))
      if (matching.length > 1)
        return yield* new Error({ code: "corrupt", message: "The review retry key names more than one run." })
      const existing = matching[0]
      if (existing) {
        if (JSON.stringify(existing.record.request) !== JSON.stringify(request))
          return yield* new Error({
            code: "conflict",
            message: "That retry key belongs to a different review request.",
          })
        return yield* get(parentID, existing.run.id)
      }
      if (Result.isFailure(admission)) return yield* admission.failure
      const total = yield* database.db
        .select({ count: sql<number>`count(*)` })
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID), eq(SessionTable.internal, MARKER)))
        .get()
        .pipe(Effect.orDie)
      if ((total?.count ?? 0) >= 1000)
        return yield* new Error({ code: "unavailable", message: "This conversation has too many local reviews." })
      const lease = yield* jobs.lease()
      if (!lease)
        return yield* new Error({
          code: "unavailable",
          message: "Durable local reviews are unavailable in this engine.",
        })
      const ownerNonce = randomUUID()
      // Once reserved, disconnect cannot leave an unstarted run artifact. The
      // worker explicitly remains interruptible in its own BackgroundJob scope.
      return yield* Effect.gen(function* () {
        const current: { abort: AbortController; finished: boolean; runID?: SessionID } = {
          abort: new AbortController(),
          finished: false,
        }
        const bridge = yield* EffectBridge.make()
        let unregister = () => {}
        const context = yield* Effect.context<RunR | ModelR | Git.Service>()
        const record: Stored = {
          version: 1,
          parentID,
          request,
          directory: admission.success.invocation.directory,
          status: "running",
          startedAt: Date.now(),
        }
        const setup = Effect.gen(function* () {
          const prepared = yield* lifecycle.within(parentID)(
            Effect.gen(function* () {
              const reservation = yield* requests.reserve({ parentID, request, ownerNonce, owner: lease })
              if (!reservation.claimed) {
                if (reservation.row.runID) return { existing: yield* get(parentID, reservation.row.runID) }
                return yield* new Error({
                  code: "unavailable",
                  message:
                    "This review request is starting or was interrupted before admission. It will not restart automatically.",
                })
              }
              unregister = ReviewLifecycle.register(ownerNonce, () =>
                Effect.gen(function* () {
                  current.abort.abort()
                  if (current.runID) yield* bridge.run(jobs.cancel(current.runID))
                }),
              )
              const run = yield* sessions.create(
                {
                  parentID,
                  internal: MARKER,
                  agent: VECTORSCOPE_AGENT,
                  title: `VectorScope · ${request.target.head.slice(0, 7)}`,
                  permission: [{ permission: "*", pattern: "*", action: "deny" }],
                  metadata: { [FIELD]: record },
                },
                "owner",
              )
              current.runID = run.id
              // A process losing this reservation may never start a job. A crash
              // before this one-time attachment can leave only an unpaid hidden
              // session; a later retry never takes over its admission authority.
              if (
                current.abort.signal.aborted ||
                !(yield* lifecycle.within(run.id)(
                  requests.attach({ parentID, requestID: request.requestID, ownerNonce, runID: run.id }),
                ))
              )
                return yield* new Error({
                  code: "unavailable",
                  message: "The local review reservation changed before execution.",
                })
              return { run }
            }),
          )
          if ("existing" in prepared) {
            if (!prepared.existing)
              return yield* new Error({
                code: "unavailable",
                message: "The retained review became unavailable during admission.",
              })
            return prepared.existing
          }
          const { run } = prepared
          active.set(run.id, current)
          const go = yield* Deferred.make<void>()
          const completed: { artifact?: ReviewRun.Artifact } = {}
          const work = Effect.gen(function* () {
            yield* Deferred.await(go)
            if (current.abort.signal.aborted) return yield* Effect.interrupt
            const result = yield* ReviewService.execute(
              { ...admission.success.invocation, parentID: run.id, stopSignal: current.abort.signal },
              {
                ...pipeline,
                confirm: async () => false,
                stdout: async () => {},
                stderr: () => {},
                posting: async () => {
                  throw new Error({ code: "invalid", message: "A local review cannot publish." })
                },
              },
            )
            current.finished = true
            const artifact = encodeArtifact(result)
            if (!artifact)
              return yield* new Error({ code: "invalid", message: "The review result exceeds its saved output limit." })
            completed.artifact = artifact
            yield* save(run.id, { ...record, artifact })
            if (current.abort.signal.aborted) return yield* Effect.interrupt
            if (result.error)
              return yield* new BackgroundJob.RunFailed({
                message: result.error.slice(0, 2048),
                output: "Local review failed.",
              })
            return "Local review finished."
          }).pipe(
            Effect.provideService(ReviewLifecycle.Current, ownerNonce),
            Effect.provide(context),
            Effect.onInterrupt(() => Effect.sync(() => current.abort.abort())),
          )
          const identity = { parentID, requestID: request.requestID, ownerNonce, runID: run.id }
          yield* lifecycle.within(
            parentID,
            run.id,
          )(
            Effect.gen(function* () {
              if (current.abort.signal.aborted || !(yield* requests.ready(identity)))
                return yield* new Error({
                  code: "unavailable",
                  message: "The review conversation closed before launch registration.",
                })
              yield* jobs.start({
                id: run.id,
                type: JOB,
                title: run.title,
                metadata: { parentSessionId: parentID, sessionId: run.id, background: true },
                durable: { parentSessionID: parentID, sessionID: run.id, directory: record.directory },
                promotable: false,
                run: Effect.interruptible(work),
                onComplete: (job) =>
                  Effect.gen(function* () {
                    const status =
                      job.status === "error" ? "failed" : job.status === "running" ? "interrupted" : job.status
                    yield* save(run.id, {
                      ...record,
                      status,
                      completedAt: job.completed_at ?? Date.now(),
                      ...(completed.artifact ? { artifact: completed.artifact } : {}),
                      ...(job.error ? { error: job.error.slice(0, 2048) } : {}),
                    })
                  }).pipe(
                    Effect.asVoid,
                    Effect.ensuring(
                      Effect.gen(function* () {
                        yield* requests.finish(identity)
                        active.delete(run.id)
                        unregister()
                      }),
                    ),
                    Effect.provideService(ReviewLifecycle.Current, ownerNonce),
                  ),
              })
            }),
          )
          const admitted = yield* lifecycle.within(
            parentID,
            run.id,
          )(current.abort.signal.aborted ? Effect.succeed(false) : requests.begin(identity))
          if (!admitted)
            return yield* new Error({
              code: "unavailable",
              message: "The review conversation closed before provider admission.",
            })
          // The native job is visible and cancellable before the latch opens.
          // No lifecycle lock is held while its work or finalizers execute.
          yield* Deferred.succeed(go, undefined)
          return yield* get(parentID, run.id)
        })
        return yield* setup.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.gen(function* () {
                  current.abort.abort()
                  if (current.runID) yield* jobs.cancel(current.runID)
                  yield* requests.finish({ parentID, requestID: request.requestID, ownerNonce })
                  if (current.runID) active.delete(current.runID)
                  unregister()
                }),
          ),
        )
      }).pipe(
        Effect.uninterruptible,
        Effect.catchTag("ReviewRequestStore.Refused", (error) =>
          Effect.fail(new Error({ code: error.code === "busy" ? "unavailable" : error.code, message: error.message })),
        ),
      )
    }, lock.withPermits(1))

    const stop: Interface["stop"] = Effect.fn("ReviewLocalRun.stop")(function* (parentID, runID) {
      const saved = yield* load(parentID, runID)
      if (saved.record.status !== "running") return yield* get(parentID, runID)
      const job = yield* jobs.get(runID)
      if (!job || !owned(job, parentID, runID))
        return yield* new Error({
          code: "unavailable",
          message: "This engine does not own the review, so it cannot stop it.",
        })
      const current = active.get(runID)
      if (current && !current.finished) current.abort.abort()
      // Give the shared runner time to return already completed structured
      // output after aborting its owned sessions. Force-stop only if it cannot
      // drain; completed partial output is saved independently of job status.
      const waited = current ? yield* jobs.wait({ id: runID, timeout: 5000 }) : undefined
      if (!waited || waited.timedOut) yield* jobs.cancel(runID)
      return yield* get(parentID, runID)
    })
    return { start, get, stop } satisfies Interface<RunR | ModelR>
  })

export function encodeArtifact(result: ReviewService.Result): ReviewRun.Artifact | undefined {
  const json = JSON.stringify(result)
  const bytes = Buffer.byteLength(json)
  if (bytes > ReviewRun.RESULT_BYTES) return undefined
  return { version: 1, json, bytes, sha256: createHash("sha256").update(json).digest("hex") }
}

export function validArtifact(artifact: ReviewRun.Artifact) {
  return (
    artifact.version === 1 &&
    Buffer.byteLength(artifact.json) === artifact.bytes &&
    artifact.bytes <= ReviewRun.RESULT_BYTES &&
    createHash("sha256").update(artifact.json).digest("hex") === artifact.sha256 &&
    Option.isSome(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(artifact.json))
  )
}

export * as ReviewLocalRun from "./local-run"
