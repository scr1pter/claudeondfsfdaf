import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import type { Target } from "@/control-plane/types"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Session } from "@/session/session"
import { HttpApiProxy } from "./proxy"
import * as Fence from "@/server/shared/fence"
import {
  getWorkspaceRouteSessionID,
  isLocalWorkspaceRoute,
  matchedRoutePath,
  workspaceProxyURL,
} from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { Flag } from "@vectordevai/core/flag/flag"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { RequestOwner } from "@vectordevai/server/request-owner"
import path from "node:path"
import { SessionID } from "@vectordevai/schema/session-id"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InvalidRequestError } from "../errors"
import { outdatedDirectoryHeader, OUTDATED_CLIENT_MESSAGE } from "@vectordevai/server/location-headers"
import {
  allowsSession,
  allowsWorkspace,
  guestWorkspaceDirectory,
  type Principal,
  RequestPrincipal,
} from "@vectordevai/protocol/middleware/authorization"

// Query fields this middleware reads from the URL. Spread into every
// endpoint query schema in groups that apply WorkspaceRoutingMiddleware,
// otherwise HttpApi rejects requests carrying these params with 400.
// HttpApiMiddleware in effect-smol cannot declare query params today —
// remove this once upstream supports middleware-declared query schemas.
export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}

export const WorkspaceRoutingQuery = Schema.Struct(WorkspaceRoutingQueryFields)

type RemoteTarget = Extract<Target, { type: "remote" }>

type RequestPlan = Data.TaggedEnum<{
  InvalidWorkspace: {}
  MissingWorkspace: { readonly workspaceID: string }
  Local: { readonly directory: string; readonly workspaceID?: WorkspaceV2.ID; readonly sessionID?: string }
  Remote: {
    readonly request: HttpServerRequest.HttpServerRequest
    readonly workspace: Workspace.Info
    readonly target: RemoteTarget
    readonly url: URL
    /** The path the router matched and the guest gate judged; the proxy forwards this, not the re-parsed URL's. */
    readonly path: string
    readonly sessionID?: string
    readonly sessionDirectory?: string
  }
}>
const RequestPlan = Data.taggedEnum<RequestPlan>()
const InvalidWorkspaceID = Symbol("InvalidWorkspaceID")

export class WorkspaceRouteContext extends Context.Service<
  WorkspaceRouteContext,
  {
    readonly directory: string
    readonly workspaceID?: WorkspaceV2.ID
  }
>()("@vector/ExperimentalHttpApiWorkspaceRouteContext") {}

export class WorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<
  WorkspaceRoutingMiddleware,
  {
    provides: WorkspaceRouteContext
    requires: Session.Service
  }
>()("@vector/ExperimentalHttpApiWorkspaceRouting") {}

function requestURL(request: HttpServerRequest.HttpServerRequest): URL {
  return new URL(request.url, "http://localhost")
}

function configuredWorkspaceID(): WorkspaceV2.ID | undefined {
  return Flag.VECTOR_WORKSPACE_ID ? WorkspaceV2.ID.make(Flag.VECTOR_WORKSPACE_ID) : undefined
}

function selectedWorkspaceID(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  sessionWorkspaceID?: WorkspaceV2.ID,
): WorkspaceV2.ID | typeof InvalidWorkspaceID | undefined {
  if (sessionWorkspaceID) return sessionWorkspaceID
  const workspaceParam = url.searchParams.get("workspace") || request.headers["x-vector-workspace"]
  if (!workspaceParam) return undefined
  const workspaceID = Schema.decodeUnknownOption(WorkspaceV2.ID)(workspaceParam)
  if (Option.isNone(workspaceID)) return InvalidWorkspaceID
  return workspaceID.value
}

function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL): string {
  const query = url.searchParams.get("directory")
  if (query) return query
  const header = request.headers["x-vector-directory"]
  if (!header) return process.cwd()
  try {
    return decodeURIComponent(header)
  } catch {
    return header
  }
}

function shouldStayOnControlPlane(request: HttpServerRequest.HttpServerRequest, routePath: string): boolean {
  return isLocalWorkspaceRoute(request.method, routePath) || routePath.startsWith("/console")
}

function resolveWorkspace(
  id: WorkspaceV2.ID | undefined,
  envWorkspaceID: WorkspaceV2.ID | undefined,
): Effect.Effect<Workspace.Info | void, never, Workspace.Service> {
  if (!id || envWorkspaceID) return Effect.void
  return Workspace.Service.use((workspace) => workspace.get(id))
}

function missingWorkspaceResponse(id: string): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(`Workspace not found: ${id}`, {
    status: 500,
    contentType: "text/plain; charset=utf-8",
  })
}

function resolveTarget(workspace: Workspace.Info): Effect.Effect<Target> {
  return WorkspaceAdapterRuntime.target(workspace)
}

function proxyRemote(
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  workspace: Workspace.Info,
  target: RemoteTarget,
  url: URL,
  path: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Socket.WebSocketConstructor | Workspace.Service> {
  return Effect.gen(function* () {
    const syncing = yield* Workspace.Service.use((svc) => svc.isSyncing(workspace.id))
    if (!syncing) {
      return HttpServerResponse.text(`broken sync connection for workspace: ${workspace.id}`, {
        status: 503,
        contentType: "text/plain; charset=utf-8",
      })
    }
    const proxyURL = workspaceProxyURL(target.url, url, path)
    const headers = request.headers as Record<string, string>
    if (headers["upgrade"]?.toLowerCase() === "websocket") return yield* HttpApiProxy.websocket(request, proxyURL)
    const response = yield* HttpApiProxy.http(client, proxyURL, target.headers, request)
    const sync = Fence.parse(new Headers(response.headers))
    if (sync) {
      const syncFailure = yield* Fence.wait(
        workspace.id,
        sync,
        request.source instanceof Request ? request.source.signal : undefined,
      ).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 503 }))),
      )
      if (syncFailure) return syncFailure
    }
    return response
  })
}

function planWorkspaceRequest(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  path: string,
  workspace: Workspace.Info,
  session?: Session.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const target = yield* resolveTarget(workspace)
    if (target.type === "remote")
      return RequestPlan.Remote({
        request,
        workspace,
        target,
        url,
        path,
        sessionID: session?.id,
        sessionDirectory: session?.directory,
      })
    return RequestPlan.Local({
      directory: session?.directory ?? target.directory,
      workspaceID: workspace.id,
      sessionID: session?.id,
    })
  })
}

function planRequest(
  request: HttpServerRequest.HttpServerRequest,
  route: { readonly template: string; readonly path: string },
  session?: Session.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const url = requestURL(request)
    const envWorkspaceID = configuredWorkspaceID()
    const workspaceID = selectedWorkspaceID(request, url, session?.workspaceID)
    if (workspaceID === InvalidWorkspaceID) {
      if (route.template.startsWith("/api/")) return RequestPlan.InvalidWorkspace()
      return RequestPlan.MissingWorkspace({ workspaceID: url.searchParams.get("workspace") ?? "unknown" })
    }
    const workspace = yield* resolveWorkspace(workspaceID, envWorkspaceID)

    if (workspaceID && workspace === undefined && !envWorkspaceID) {
      return RequestPlan.MissingWorkspace({ workspaceID })
    }

    if (workspace !== undefined && !envWorkspaceID && !shouldStayOnControlPlane(request, route.template)) {
      return yield* planWorkspaceRequest(request, url, route.path, workspace, session)
    }

    return RequestPlan.Local({
      directory: session?.directory || defaultDirectory(request, url),
      workspaceID: envWorkspaceID ?? workspaceID,
      sessionID: session?.id,
    })
  })
}

function invalidPtyTicket() {
  return HttpServerResponse.jsonUnsafe(
    { _tag: "ForbiddenError", message: "Invalid PTY connect ticket" },
    { status: 403 },
  )
}

function routePtyTicket<E>(
  client: HttpClient.HttpClient,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
  principal: Extract<Principal, { readonly kind: "pty-ticket" }>,
) {
  return Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    return yield* RequestPlan.$match(plan, {
      InvalidWorkspace: () => Effect.succeed(invalidPtyTicket()),
      MissingWorkspace: () => Effect.succeed(invalidPtyTicket()),
      Remote: ({ request, workspace, target, url, path }) => proxyRemote(client, request, workspace, target, url, path),
      Local: ({ directory, workspaceID }) =>
        Effect.gen(function* () {
          const valid = yield* tickets.consume({
            ptyID: principal.ptyID,
            ticket: principal.ticket,
            directory,
            workspaceID,
          })
          if (!valid) return invalidPtyTicket()
          return yield* effect.pipe(
            Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory, workspaceID })),
          )
        }),
    })
  })
}

function routeWorkspace<E>(
  client: HttpClient.HttpClient,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
  guestInput: Effect.Effect<boolean>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  PtyTicket.Service | Socket.WebSocketConstructor | Workspace.Service
> {
  return Effect.gen(function* () {
    const principal = yield* RequestPrincipal
    if (principal.kind === "pty-ticket") return yield* routePtyTicket(client, effect, plan, principal)
    const allowed = RequestPlan.$match(plan, {
      InvalidWorkspace: () => true,
      MissingWorkspace: () => principal.kind === "owner",
      Remote: ({ workspace, sessionID, sessionDirectory }) =>
        sessionID === undefined
          ? allowsWorkspace(principal, workspace.id)
          : allowsSession(principal, sessionID) ||
            guestWorkspaceDirectory(principal, workspace.id) === sessionDirectory,
      Local: ({ directory, workspaceID, sessionID }) => {
        if (principal.kind === "owner") return true
        if (sessionID !== undefined)
          return allowsSession(principal, sessionID) || guestWorkspaceDirectory(principal, workspaceID) === directory
        return guestWorkspaceDirectory(principal, workspaceID) !== undefined
      },
    })
    if (!allowed)
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "Guest credential is not scoped to this workspace or session" },
        { status: 403 },
      )
    return yield* RequestPlan.$match(plan, {
      InvalidWorkspace: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            new InvalidRequestError({
              message: "Invalid workspace query parameter",
              kind: "Query",
              field: "workspace",
            }),
            { status: 400 },
          ),
        ),
      MissingWorkspace: ({ workspaceID }) => Effect.succeed(missingWorkspaceResponse(workspaceID)),
      // The remote engine sees the owner's credentials, so a guest's request says it is a guest's. The session is
      // marked here too, so it keeps the mark if it is warped back to this engine.
      Remote: ({ request, workspace, target, url, path }) =>
        guestInput.pipe(
          Effect.flatMap((admitted) =>
            admitted
              ? proxyRemote(
                  client,
                  request,
                  workspace,
                  principal.kind === "guest" || RequestOwner.forwarded(request)
                    ? { ...target, headers: RequestOwner.relayHeaders(target.headers) }
                    : target,
                  url,
                  path,
                )
              : Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { _tag: "ForbiddenError", message: "This session's raw content is available only to the owner." },
                    { status: 403 },
                  ),
                ),
          ),
        ),
      Local: ({ directory, workspaceID, sessionID }) =>
        guestInput.pipe(
          Effect.flatMap((admitted) =>
            admitted
              ? effect.pipe(
                  Effect.provideService(
                    WorkspaceRouteContext,
                    WorkspaceRouteContext.of({
                      directory:
                        principal.kind === "guest" && (sessionID === undefined || !allowsSession(principal, sessionID))
                          ? guestWorkspaceDirectory(principal, workspaceID)!
                          : directory,
                      workspaceID,
                    }),
                  ),
                )
              : Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { _tag: "ForbiddenError", message: "This session's raw content is available only to the owner." },
                    { status: 403 },
                  ),
                ),
          ),
        ),
    })
  })
}

function routeHttpApiWorkspace<E>(
  client: HttpClient.HttpClient,
  guests: FreeModelGuests.Interface,
  audience: SessionAudience.Interface,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  | Session.Service
  | Workspace.Service
  | PtyTicket.Service
  | HttpServerRequest.HttpServerRequest
  | HttpRouter.RouteContext
  | Socket.WebSocketConstructor
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const header = outdatedDirectoryHeader(request.headers)
    if (header) {
      return HttpServerResponse.jsonUnsafe(
        new InvalidRequestError({ message: OUTDATED_CLIENT_MESSAGE, kind: "client_outdated", field: header }),
        { status: 400 },
      )
    }
    // Judge scope by the route the router matched. The URL parser reads another path for spellings the router
    // accepts (case, '//', ';x', dot segments after ';'), so a re-parsed path could name a session the guest may open
    // while the handler serves a different one.
    const route = yield* HttpRouter.RouteContext
    const sessionID = getWorkspaceRouteSessionID(route.params)
    const principal = yield* RequestPrincipal
    const owner = principal.kind === "owner" && !RequestOwner.forwarded(request)
    for (const value of RequestOwner.fileSelectors(request, route.route.path))
      if (
        !owner &&
        (yield* audience.overlapsPrivateDirectory(path.resolve(defaultDirectory(request, requestURL(request)), value)))
      )
        return HttpServerResponse.jsonUnsafe(
          { _tag: "ForbiddenError", message: "This filesystem selection includes an owner-only working directory." },
          { status: 403 },
        )
    for (const value of RequestOwner.paths(request))
      if (!owner && (yield* audience.isPrivateDirectory(value)))
        return HttpServerResponse.jsonUnsafe(
          { _tag: "ForbiddenError", message: "This working directory is available only to the owner." },
          { status: 403 },
        )
    if (
      !owner &&
      ((sessionID && !RequestOwner.counts(request, route.route.path) && (yield* audience.isPrivate(sessionID))) ||
        (yield* audience.isPrivateDirectory(defaultDirectory(request, requestURL(request)))))
    )
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "This session's raw content is available only to the owner." },
        { status: 403 },
      )
    // Workflow planning and execution are owner actions even when an adapter would forward with owner credentials.
    if (
      !owner &&
      [
        "/experimental/workflow/saved",
        "/experimental/workflow/validate",
        "/experimental/session/:sessionID/workflow",
        "/experimental/session/:sessionID/workflow/:runID/resume",
      ].includes(route.route.path) &&
      (request.method === "POST" || route.route.path === "/experimental/workflow/saved")
    )
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "Only the server owner can validate or start workflows." },
        { status: 403 },
      )
    // Remote targets authenticate with the adapter's owner credentials. Apply task-control ownership before
    // forwarding, while the original guest principal is still available, as well as in the local handler.
    // Merging and discarding need the authenticated owner: a guest in control, or owner credentials relaying a
    // guest, are refused before any forward.
    if (
      request.method === "POST" &&
      !owner &&
      [
        "/experimental/session/:sessionID/tasks/:taskID/merge",
        "/experimental/session/:sessionID/tasks/:taskID/discard",
      ].includes(route.route.path)
    )
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "Only the server owner can merge or discard a subagent's worktree." },
        { status: 403 },
      )
    if (
      request.method === "POST" &&
      ((route.route.path.startsWith("/experimental/session/:sessionID/tasks/bridge/") && !owner) ||
        ([
          "/experimental/session/:sessionID/workflow",
          "/experimental/session/:sessionID/workflow/:runID/resume",
          "/experimental/session/:sessionID/stop",
          "/experimental/session/:sessionID/background",
          "/experimental/session/:sessionID/tasks/background",
          "/experimental/session/:sessionID/tasks/resume",
          "/experimental/session/:sessionID/tasks/stop",
          "/experimental/session/:sessionID/tasks/:taskID/message",
        ].includes(route.route.path) &&
          (!sessionID || !allowsSession(principal, sessionID))))
    )
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "This session's tasks are outside your authorized sessions" },
        { status: 403 },
      )
    const session = sessionID
      ? yield* Session.Service.use((svc) => svc.get(sessionID)).pipe(
          Effect.catchIf(
            (error): error is NotFoundError => NotFoundError.isInstance(error),
            () => Effect.succeed(undefined),
          ),
          Effect.catchDefect(() => Effect.succeed(undefined)),
        )
      : undefined
    if (/^\/experimental\/session\/:sessionID\/review(?:\/|$)/.test(route.route.path)) {
      // Review routing has no directory fallback. An absent/defective parent
      // lookup must not bootstrap or forward to a caller-selected project
      // before the owner adapter gets to validate its placement.
      if (!owner)
        return HttpServerResponse.jsonUnsafe(
          { _tag: "ForbiddenError", message: "Local reviews require the server owner." },
          { status: 403 },
        )
      if (!session)
        return HttpServerResponse.jsonUnsafe(
          { code: "not_found", message: "Review conversation not found." },
          { status: 400 },
        )
      if (session.parentID || session.internal || !path.isAbsolute(session.directory))
        return HttpServerResponse.jsonUnsafe(
          { code: "invalid", message: "Local reviews belong to an existing main conversation." },
          { status: 400 },
        )
      const requestedWorkspace =
        requestURL(request).searchParams.get("workspace") || request.headers["x-vector-workspace"]
      if (
        requestedWorkspace &&
        requestedWorkspace !== session.workspaceID &&
        requestedWorkspace !== configuredWorkspaceID()
      )
        return HttpServerResponse.jsonUnsafe(
          { code: "placement", message: "A local review cannot select another workspace." },
          { status: 400 },
        )
    }
    const plan = yield* planRequest(
      request,
      { template: route.route.path, path: matchedRoutePath(route.route.path, route.params) },
      session,
    )
    if (!owner && plan._tag === "Local" && (yield* audience.isPrivateDirectory(plan.directory)))
      return HttpServerResponse.jsonUnsafe(
        { _tag: "ForbiddenError", message: "This working directory is available only to the owner." },
        { status: 403 },
      )
    if (!owner && plan._tag === "Local")
      for (const value of RequestOwner.fileSelectors(request, route.route.path))
        if (yield* audience.overlapsPrivateDirectory(path.resolve(plan.directory, value)))
          return HttpServerResponse.jsonUnsafe(
            { _tag: "ForbiddenError", message: "This filesystem selection includes an owner-only working directory." },
            { status: 403 },
          )
    if (!owner && plan._tag === "Local")
      for (const value of RequestOwner.paths(request))
        if (yield* audience.isPrivateDirectory(path.resolve(plan.directory, value)))
          return HttpServerResponse.jsonUnsafe(
            { _tag: "ForbiddenError", message: "This working directory is available only to the owner." },
            { status: 403 },
          )
    // Whatever a guest changes in a session, a prompt, a compaction, a message to a subagent, keeps that session's
    // free-model requests off models that may train (FreeModelGuests). It is recorded before the handler runs, and
    // only once the guest is allowed in the session.
    const guestSession = Schema.decodeUnknownOption(SessionID)(sessionID)
    const guestInput =
      !owner && request.method !== "GET" && request.method !== "HEAD" && Option.isSome(guestSession)
        ? audience.markGuest(guestSession.value).pipe(
            Effect.andThen(guests.mark(guestSession.value)),
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
        : Effect.succeed(true)
    return yield* routeWorkspace(client, effect, plan, guestInput)
  })
}

export const workspaceRoutingLayer = Layer.effect(
  WorkspaceRoutingMiddleware,
  Effect.gen(function* () {
    const makeWebSocket = yield* Socket.WebSocketConstructor
    const workspace = yield* Workspace.Service
    const client = yield* HttpClient.HttpClient
    const tickets = yield* PtyTicket.Service
    const guests = yield* FreeModelGuests.Service
    const audience = yield* SessionAudience.Service
    return WorkspaceRoutingMiddleware.of((effect) =>
      routeHttpApiWorkspace(client, guests, audience, effect).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
        Effect.provideService(Workspace.Service, workspace),
        Effect.provideService(PtyTicket.Service, tickets),
      ),
    )
  }),
)
