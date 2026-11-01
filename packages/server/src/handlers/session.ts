import { SessionV2 } from "@vectordevai/core/session"
import { Catalog } from "@vectordevai/core/catalog"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { freeModelDataPolicy, isFreeModelRef } from "@vectordevai/core/free-model-catalog"
import { FreeModels } from "@vectordevai/core/free-models"
import { Location } from "@vectordevai/core/location"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { PluginInternal } from "@vectordevai/core/plugin/internal"
import { DateTime, Effect, Option, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@vectordevai/protocol/groups/session"
import {
  ConflictError,
  ForbiddenError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@vectordevai/protocol/errors"
import { AbsolutePath } from "@vectordevai/core/schema"
import { isHelperName } from "@vectordevai/core/session/helper"
import {
  allowsSession,
  guestWorkspaceDirectory,
  type Principal,
  RequestPrincipal,
} from "@vectordevai/protocol/middleware/authorization"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

function allowsSessionLocation(principal: Principal, item: SessionV2.Info) {
  if (allowsSession(principal, item.id)) return true
  if (principal.kind === "owner") return true
  return guestWorkspaceDirectory(principal, item.location.workspaceID) === item.location.directory
}

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const guard = yield* SpendGuard.Service

    // Whether the principal may open a session by its ID; a session that cannot be read is never allowed.
    const allowsSessionID = (principal: Principal, sessionID: SessionV2.ID) =>
      allowsSession(principal, sessionID)
        ? Effect.succeed(true)
        : session.get(sessionID).pipe(
            Effect.map((item) => allowsSessionLocation(principal, item)),
            Effect.catch(() => Effect.succeed(false)),
          )

    return handlers
      .handle(
        "session.importArchive",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.importArchive({
              archive: ctx.payload.archive,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.share",
        Effect.fn(function* (ctx) {
          return { data: yield* session.share({ sessionID: ctx.params.sessionID, ...ctx.payload }) }
        }),
      )
      .handle(
        "session.sharePreview",
        Effect.fn(function* (ctx) {
          return { data: yield* session.sharePreview(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.shareFlush",
        Effect.fn(function* (ctx) {
          return { data: yield* session.shareFlush(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.unshare",
        Effect.fn(function* (ctx) {
          yield* session.unshare(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session
            .list({
              ...query,
              workspaceID: query.workspace,
              limit: ctx.query.limit ?? DefaultSessionsLimit,
            })
            .pipe(Effect.catch((error) => Effect.logError("Failed to list Vector sessions", error).pipe(Effect.as([]))))
          const principal = yield* RequestPrincipal
          const allowed = sessions.filter((item) => allowsSessionLocation(principal, item))
          const first = allowed[0]
          const last = allowed.at(-1)
          return {
            data: allowed,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          const principal = yield* RequestPrincipal
          const requested = ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) }
          const guestDirectory = guestWorkspaceDirectory(principal, requested.workspaceID)
          if (principal.kind === "guest" && guestDirectory === undefined)
            return yield* new ForbiddenError({ message: "Guest sessions require an allowed workspace" })
          // A guest's session may hang only under a session the guest may open. A helper session is left out of every
          // list, so a guest's helper needs such a parent: its spend then shows in a session the owner sees.
          if (principal.kind !== "owner" && ctx.payload.parentID === undefined && ctx.payload.internal !== undefined)
            return yield* new ForbiddenError({ message: "A guest's helper session must belong to one of its sessions" })
          if (ctx.payload.parentID !== undefined && !(yield* allowsSessionID(principal, ctx.payload.parentID)))
            return yield* new ForbiddenError({ message: "The parent session is outside the guest's workspace" })
          // Every list leaves out a session whose `internal` is set, so a session may hide only under a helper's name.
          if (ctx.payload.internal !== undefined && !isHelperName(ctx.payload.internal))
            return yield* new InvalidRequestError({
              message: "internal must name one of Vector's helpers",
              field: "internal",
            })
          const location =
            principal.kind === "guest"
              ? Location.Ref.make({ directory: AbsolutePath.make(guestDirectory!), workspaceID: requested.workspaceID })
              : requested
          const created = yield* session.create({
            id: ctx.payload.id,
            agent: ctx.payload.agent,
            model: ctx.payload.model,
            location,
            title: ctx.payload.title,
            parentID: ctx.payload.parentID,
            internal: ctx.payload.internal,
          })
          // An ID that already names a session adopts it wherever it lives, so the guest's claims decide the answer.
          if (!allowsSessionLocation(principal, created))
            return yield* new ForbiddenError({ message: "This session is outside the guest's workspace" })
          return { data: created }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          const principal = yield* RequestPrincipal
          const allowed = yield* Effect.filter(Array.from(yield* session.active), (sessionID) =>
            allowsSessionID(principal, sessionID),
          )
          return {
            data: Object.fromEntries(allowed.map((sessionID) => [sessionID, { type: "running" as const }])),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          // Every request in a session a guest has worked in is kept off models that may train (FreeModelGuests), so a
          // guest's switch to one is refused here, where it can be explained.
          if ((yield* RequestPrincipal).kind !== "owner") yield* refuseTrainingFreeModel(ctx.payload.model)
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.resumeFreeModels",
        Effect.fn(function* (ctx) {
          // Resuming runs the turn on the owner's OpenRouter account and acceptance, so a guest may not resume one
          // whose model may train.
          if ((yield* RequestPrincipal).kind !== "owner")
            yield* refuseTrainingFreeModel({ providerID: ProviderV2.ID.openrouter, id: ctx.payload.modelID })
          yield* session.resumeFreeModels({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("FreeModelsResume.Rejected", (error) =>
              Effect.fail(new InvalidRequestError({ message: error.message })),
            ),
            Effect.catch((error) =>
              Effect.fail(
                error instanceof SessionNotFoundError || error instanceof InvalidRequestError
                  ? error
                  : new UnknownError({ message: error.message }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          // A guest never accepted the free-model training notice, so the owner's acceptance must not carry a guest's
          // prompt to a model that may train. The prompt runs on the session's model, or the default without one.
          // The model is judged as the runner chooses it, so a session without one is judged by its automatic choice.
          if ((yield* RequestPrincipal).kind !== "owner") {
            const current = yield* session.get(ctx.params.sessionID).pipe(Effect.option)
            yield* pluginsLoaded
            const catalog = yield* Effect.serviceOption(Catalog.Service)
            if (Option.isSome(current))
              yield* refuseTrainingFreeModel(
                Option.isSome(catalog)
                  ? yield* SessionRunnerModel.select(catalog.value, current.value).pipe(
                      Effect.orElseSucceed(() => current.value.model),
                    )
                  : current.value.model,
              )
          }
          // The budget is armed in memory before admission, so the drain that promotes this input runs under it. A guest's
          // budget can only tighten the limits the owner's run has.
          if (ctx.payload.budget)
            yield* (yield* RequestPrincipal).kind === "owner"
              ? guard.arm(ctx.params.sessionID, ctx.payload.budget)
              : guard.tighten(ctx.params.sessionID, ctx.payload.budget)
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.spend",
        Effect.fn(function* (ctx) {
          const run = yield* guard.snapshot(ctx.params.sessionID)
          if (!run) return {}
          return {
            data: {
              sessionID: run.rootID,
              state: run.stopped ? ("stopped" as const) : run.warned ? ("warn" as const) : ("ok" as const),
              reason: run.stopped?.reason,
              message: run.stopped?.message ?? (run.warned ? SpendGuard.warnMessage(run) : undefined),
              budget: run.budget,
              spentUsd: run.spentUsd,
              steps: run.steps,
              unpricedSteps: run.unpricedSteps,
              codiumSteps: run.codiumSteps,
              costKind: run.costKind,
            },
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)

// A location's plugins fill its catalog in the background as it starts, and a guest's first request can be what starts
// it, so a guest's check waits for them rather than judging an empty catalog. Read optionally, like the services below:
// embedded callers provide no location plugins, so there is nothing to wait for.
const pluginsLoaded = Effect.serviceOption(PluginInternal.Service).pipe(
  Effect.flatMap((plugins) => (Option.isSome(plugins) ? plugins.value.ready : Effect.void)),
)

/**
 * Refuses an invited guest's prompt or resume that would run on a free model whose provider may train on prompts: it
 * would run under the owner's acceptance, which the guest never gave. A shared model's policy comes from the shared
 * catalog itself; a model on the owner's own OpenRouter account comes from the location's catalog, read once the
 * location's plugins have filled it. Both are read whichever provider the prompt names, so the stricter policy wins. A
 * free model whose policy is found nowhere is not treated as no-training.
 */
const refuseTrainingFreeModel = Effect.fn("SessionHandler.refuseTrainingFreeModel")(function* (
  model: { readonly providerID: string; readonly id: string } | undefined,
) {
  if (!model || !isFreeModelRef({ providerID: model.providerID, modelID: model.id })) return
  yield* pluginsLoaded
  // Read optionally so the routes need no services of their own beyond the location's (embedded callers pass one
  // argument to the web handler). Without them the policy cannot be read, so the guest is refused.
  const freeModelsService = yield* Effect.serviceOption(FreeModels.Service)
  const catalogService = yield* Effect.serviceOption(Catalog.Service)
  if (Option.isNone(freeModelsService) || Option.isNone(catalogService))
    return yield* new ForbiddenError({ message: FREE_MODEL_TRAINING_OWNER_ONLY })
  const freeModels = freeModelsService.value
  const catalog = catalogService.value
  const shared = yield* freeModels.catalog()
  const located = yield* Effect.forEach([ProviderV2.ID.vector, ProviderV2.ID.openrouter], (providerID) =>
    catalog.model.get(providerID, ModelV2.ID.make(model.id)),
  )
  const policies = [
    ...(shared.enabled ? shared.models : []).filter((item) => item.id === model.id).map(freeModelDataPolicy),
    ...located.flatMap((item) => (item?.freeModel ? [item.freeModel.dataPolicy ?? "may-train"] : [])),
  ]
  if (!policies.length || policies.some((policy) => policy !== "no-training"))
    return yield* new ForbiddenError({ message: FREE_MODEL_TRAINING_OWNER_ONLY })
})
