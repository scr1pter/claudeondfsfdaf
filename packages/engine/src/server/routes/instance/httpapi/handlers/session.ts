import { PublicShareRemovalError, publicShareWarning } from "@vectordevai/schema/public-share"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { Config } from "@/config/config"
import { ShareNext } from "@/share/share-next"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { ModelV2 } from "@vectordevai/core/model"
import { Provider } from "@/provider/provider"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { freeModelMayTrain, FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@vectordevai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect/instance-state"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { InvalidRequestError, PermissionNotFoundError, notFound } from "../errors"
import * as SessionError from "./session-errors"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { isHelperName } from "@vectordevai/core/session/helper"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { allowsSessionID, allowsSessionLocation } from "./session-access"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const publicSharing = yield* PublicSessionShare.Service
    const config = yield* Config.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const provider = yield* Provider.Service
    const guests = yield* FreeModelGuests.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const sessions = yield* session
        .list({
          directory: ctx.query.scope === "project" ? undefined : directory,
          scope: ctx.query.scope,
          path: ctx.query.path,
          roots: ctx.query.roots,
          internal: ctx.query.internal,
          start: ctx.query.start,
          search: ctx.query.search,
          limit: ctx.query.limit,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("session.list failed; returning an empty session list", {
              cause: Cause.pretty(cause),
              query: ctx.query,
            }).pipe(Effect.as([])),
          ),
        )
      const principal = yield* RequestPrincipal
      return yield* Effect.filter(sessions, (item) => allowsSessionLocation(principal, item))
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      const principal = yield* RequestPrincipal
      const statuses = yield* statusSvc.list()
      const allowed = yield* Effect.filter(statuses, ([sessionID]) => allowsSessionID(session, principal, sessionID))
      return Object.fromEntries(allowed)
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      yield* SessionAudienceHttp.assertSession(sessionID, yield* RequestOwner.owner)
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    // A session's own rules come last and win, so an allow or ask from a guest would let its session skip the
    // owner's approval for an outside directory, a guarded file or an unsandboxed shell. A guest may only take
    // tools away; switching one on, as rules or as a prompt's tools, stays with the owner.
    const requireOwnerToAllow = Effect.fn("SessionHttpApi.requireOwnerToAllow")(function* (input: {
      readonly permission?: readonly PermissionV1.Rule[]
      readonly tools?: Readonly<Record<string, boolean>>
    }) {
      if (yield* RequestOwner.owner) return
      if (!input.permission?.some((rule) => rule.action !== "deny") && !Object.values(input.tools ?? {}).includes(true))
        return
      return yield* new ForbiddenError({ message: "Only the server owner can allow tools in a session" })
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const principal = yield* RequestPrincipal
      return yield* Effect.filter(yield* session.children(ctx.params.sessionID), (item) =>
        allowsSessionLocation(principal, item),
      )
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      // The diff endpoint declares no not-found error, so only the privacy gate runs before the summary read.
      yield* SessionAudienceHttp.assertSession(ctx.params.sessionID, yield* RequestOwner.owner)
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      yield* requireOwnerToAllow({ permission: ctx.payload?.permission })
      yield* requireGuestParent({ parentID: ctx.payload?.parentID, internal: ctx.payload?.internal })
      // Every list leaves out a session whose `internal` is set, so a session may hide only under a helper's name.
      const internal = ctx.payload?.internal
      if (internal !== undefined && !isHelperName(internal))
        return yield* new InvalidRequestError({
          message: "internal must name one of Vector's helpers",
          field: "internal",
        })
      const owner = yield* RequestOwner.owner
      if (ctx.payload?.parentID) yield* SessionAudienceHttp.admit(ctx.payload.parentID, owner)
      const created = yield* shareSvc
        .create(ctx.payload, owner ? "owner" : "guest")
        .pipe(
          Effect.catchDefect((error) =>
            error instanceof SessionAudience.Denied
              ? Effect.fail(new ForbiddenError({ message: error.message }))
              : Effect.die(error),
          ),
        )
      yield* SessionAudienceHttp.admit(created.id, owner)
      return created
    })

    // A guest's session may hang only under a session the guest may open. A helper session is left out of every
    // list, so a guest's helper needs such a parent: its spend then shows in a session the owner sees.
    const requireGuestParent = Effect.fn("SessionHttpApi.requireGuestParent")(function* (input: {
      readonly parentID?: SessionID
      readonly internal?: string
    }) {
      const principal = yield* RequestPrincipal
      if (yield* RequestOwner.owner) return
      if (input.parentID === undefined && input.internal === undefined) return
      if (input.parentID === undefined)
        return yield* new ForbiddenError({ message: "A guest's helper session must belong to one of its sessions" })
      if (yield* allowsSessionID(session, principal, input.parentID)) return
      return yield* new ForbiddenError({ message: "The parent session is outside the guest's workspace" })
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: {
      params: { sessionID: SessionID }
      query: { acknowledgePublicShares?: boolean }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const sharing = yield* ShareNext.Service
      const links = yield* sharing.publicLinks(ctx.params.sessionID)
      yield* session
        .remove(ctx.params.sessionID, ctx.query)
        .pipe(Effect.catchTag("NotFoundError", (error) => Effect.fail(notFound(error.message))))
      if (links.length) return { deleted: true as const, warnings: [publicShareWarning(links).message], links }
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      yield* requireOwnerToAllow({ permission: ctx.payload.permission })
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        yield* SubagentLifecycle.setPublicMetadata(session, ctx.params.sessionID, ctx.payload.metadata).pipe(
          Effect.catchTag("NotFoundError", (error) => Effect.fail(notFound(error.message))),
        )
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const forked = yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
      // A fork copies the history, a guest's messages included, so it keeps the source's guest mark (FreeModelGuests).
      if (yield* guests.marked(ctx.params.sessionID)) yield* guests.mark(forked.id)
      yield* SessionAudienceHttp.admit(forked.id, yield* RequestOwner.owner)
      return forked
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: PublicSession.Publish
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!ShareNext.enabled((yield* config.get()).share)) {
        return yield* new InvalidRequestError({ message: ShareNext.disabledReason(), kind: "SharingUnavailable" })
      }
      return yield* shareSvc.share(ctx.params.sessionID, ctx.payload)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(
          Effect.mapError((error) =>
            error instanceof PublicShareRemovalError || error instanceof PublicSession.Error
              ? error
              : new HttpApiError.InternalServerError({}),
          ),
        )
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      // Compaction sends the whole history to the model it names, so a guest may not name one that may train: the
      // owner's acceptance is not the guest's. The request itself would be refused where it is sent (FreeModelGuests);
      // this refuses it before a compaction is recorded.
      if (!(yield* RequestOwner.owner)) {
        const chosen = yield* provider
          .getModel(ctx.payload.providerID, ctx.payload.modelID)
          .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (chosen && freeModelMayTrain(chosen)) {
          yield* events.publish(Session.Event.Error, {
            sessionID: ctx.params.sessionID,
            error: new NamedError.Unknown({ message: FREE_MODEL_TRAINING_OWNER_ONLY }).toObject(),
          })
          return yield* new HttpApiError.BadRequest({})
        }
      }
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })

    // The owner's files are theirs to attach from anywhere. A guest's go through the workspace boundary and read
    // permission, which only the owner can approve, and a guest's budget can only tighten the owner's run limits. A
    // guest never accepted the free-model training notice, so the owner's acceptance does not carry a guest's prompt to
    // a model that may train. Where research searches is the owner's choice too.
    const promptOptions = Effect.gen(function* () {
      return (yield* RequestOwner.owner)
        ? { userFile: () => true }
        : { tightenBudget: true, refuseTrainingFreeModels: true, dropResearchOptions: true }
    })

    // An isolated task, or a descendant of a retired one, is refused here with a client error before anything is
    // stored, instead of failing inside the run.
    const admitted = (sessionID: SessionID) =>
      promptSvc.admit(sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* requireOwnerToAllow({ tools: ctx.payload.tools })
      yield* admitted(ctx.params.sessionID)
      yield* SessionAudienceHttp.admit(ctx.params.sessionID, yield* RequestOwner.owner)
      const message = yield* promptSvc
        .prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }, yield* promptOptions)
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* requireOwnerToAllow({ tools: ctx.payload.tools })
      yield* admitted(ctx.params.sessionID)
      yield* SessionAudienceHttp.admit(ctx.params.sessionID, yield* RequestOwner.owner)
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }, yield* promptOptions).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const resumeFreeModels = Effect.fn("SessionHttpApi.resumeFreeModels")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { messageID: MessageID; modelID: ModelV2.ID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const owner = yield* RequestOwner.owner
      yield* promptSvc
        .admit(ctx.params.sessionID)
        .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
      yield* SessionAudienceHttp.admit(ctx.params.sessionID, owner)
      yield* promptSvc
        .resumeFreeModels({ ...ctx.payload, sessionID: ctx.params.sessionID }, { refuseTrainingFreeModels: !owner })
        .pipe(
          Effect.catchTag("SessionBusyError", (error) => SessionError.mapBusy(Effect.fail(error))),
          Effect.catchTag("FreeModelsResumeError", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
        )
      return true
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* admitted(ctx.params.sessionID)
      yield* SessionAudienceHttp.admit(ctx.params.sessionID, yield* RequestOwner.owner)
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* admitted(ctx.params.sessionID)
      yield* SessionAudienceHttp.admit(ctx.params.sessionID, yield* RequestOwner.owner)
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapRevert(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapRevert(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("sharePreview", (ctx) => publicSharing.preview({ sessionID: ctx.params.sessionID }))
      .handle("shareFlush", (ctx) => publicSharing.flush(ctx.params.sessionID))
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("resumeFreeModels", resumeFreeModels)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
