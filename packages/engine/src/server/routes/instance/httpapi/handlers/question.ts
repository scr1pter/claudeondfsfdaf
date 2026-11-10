import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Session } from "@/session/session"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { FreeModelGuests, GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"
import { allowsSessionID } from "./session-access"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const session = yield* Session.Service
    const guests = yield* FreeModelGuests.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      const principal = yield* RequestPrincipal
      return yield* Effect.filter(yield* svc.list(), (item) => allowsSessionID(session, principal, item.sessionID))
    })

    // A guest answers only the questions its own sessions ask. Another session's question reads as
    // missing, so its existence is not confirmed either.
    const requireVisible = Effect.fn("QuestionHttpApi.requireVisible")(function* (requestID: QuestionID) {
      const principal = yield* RequestPrincipal
      const request = (yield* svc.list()).find((item) => item.id === requestID)
      const owner = yield* RequestOwner.owner
      if (request) yield* SessionAudienceHttp.assertSession(request.sessionID, owner)
      // A guest's answer goes to the session's model as a tool result, so it keeps that session's free-model
      // requests off models that may train (FreeModelGuests), as a guest's prompt does. One forwarded from another
      // engine's guest arrives with the owner's credentials and says so in a header.
      if (principal.kind === "owner") {
        if (request && !owner) yield* SessionAudienceHttp.admit(request.sessionID, false)
        if (request && (yield* HttpServerRequest.HttpServerRequest).headers[GUEST_REQUEST_HEADER] === "1")
          yield* guests.mark(request.sessionID)
        return
      }
      if (request && (yield* allowsSessionID(session, principal, request.sessionID))) {
        yield* SessionAudienceHttp.admit(request.sessionID, false)
        return yield* guests.mark(request.sessionID)
      }
      return yield* new QuestionNotFoundError({
        requestID: String(requestID),
        message: `Question request not found: ${requestID}`,
      })
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* requireVisible(ctx.params.requestID)
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* requireVisible(ctx.params.requestID)
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
