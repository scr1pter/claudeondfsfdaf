import { SessionAudience } from "@vectordevai/core/session/audience"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { SessionSchema } from "@vectordevai/core/session/schema"
import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { gunzipSync, inflateSync } from "node:zlib"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RequestOwner } from "./request-owner"

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
const identity = (value: unknown) => Option.isSome(Schema.decodeUnknownOption(SessionSchema.ID)(value))

// References can only remove visibility. An incidental nested ID never scopes an otherwise unknown event.
function references(value: unknown) {
  const ids = new Set<string>()
  const directories = new Set<string>()
  const pending: unknown[] = [value]
  for (const value of pending) {
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    for (const [key, item] of Object.entries(object(value))) {
      if (/^ses[_-][a-zA-Z0-9_-]+$/.test(key)) ids.add(key)
      if (typeof item !== "string") {
        if (item && typeof item === "object") pending.push(item)
        continue
      }
      if (
        ["id", "sessionID", "taskID", "parentID", "parentSessionID", "aggregateID", "aggregate_id"].includes(key) &&
        identity(item)
      )
        ids.add(item)
      if (
        ["directory", "worktree", "path", "outputPath"].includes(key) &&
        (path.isAbsolute(item) || path.win32.isAbsolute(item))
      )
        directories.add(item)
    }
  }
  return { ids, directories }
}

/**
 * Only the exact counts DTO, on the one route that serves it, can bypass the private-family ID guard. The shape is
 * recognized from the final bytes rather than by response identity: compression and other transforms replace the
 * response object before transport. No header or query flag can produce this shape from a raw record.
 */
function countsOnly(value: unknown) {
  const root = object(value)
  const task = object(root.task)
  const controls = object(task.controls)
  const isolation = object(task.isolation)
  if (
    !keys(root, ["task", "files", "truncated", "mergeable"]) ||
    !Array.isArray(root.files) ||
    root.files.length !== 0 ||
    root.truncated !== false ||
    root.mergeable !== "unknown" ||
    !keys(task, [
      "id",
      "sessionID",
      "parentSessionID",
      "source",
      "title",
      "status",
      "startedAt",
      "elapsedMs",
      "ownedPaths",
      "dependsOn",
      "resultAvailable",
      "attempt",
      "controls",
      "isolation",
    ]) ||
    !identity(task.id) ||
    task.sessionID !== task.id ||
    !identity(task.parentSessionID) ||
    task.source !== "subagent" ||
    task.title !== "Isolated task" ||
    task.startedAt !== 0 ||
    task.elapsedMs !== 0 ||
    !Array.isArray(task.ownedPaths) ||
    task.ownedPaths.length !== 0 ||
    !Array.isArray(task.dependsOn) ||
    task.dependsOn.length !== 0 ||
    task.resultAvailable !== false ||
    task.attempt !== 0 ||
    !["queued", "running", "waiting_on_user", "completed", "failed", "stopped"].includes(text(task.status) ?? "") ||
    !keys(controls, ["inspect", "message", "stop"]) ||
    Object.values(controls).some((value) => value !== false) ||
    !keys(isolation, ["mode", "state", "files", "additions", "deletions"]) ||
    !["worktree", "copy"].includes(text(isolation.mode) ?? "") ||
    !["preparing", "active", "settling", "unchanged", "changed", "merged", "discarded", "diverged", "failed"].includes(
      text(isolation.state) ?? "",
    ) ||
    ![isolation.files, isolation.additions, isolation.deletions].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  )
    return false
  return true
}

/** Validate a server-built counts response before it leaves the handler. */
export function projected(response: HttpServerResponse.HttpServerResponse) {
  const serialized = transported(response)
  if (serialized === undefined || response.body._tag !== "Uint8Array" || !response.body.contentType.includes("json"))
    throw new Error("A counts projection must be a JSON response.")
  if (!countsOnly(JSON.parse(serialized)))
    throw new Error("The counts projection contains fields outside its safe shape.")
  return response
}

/** The decoded text of a buffered body as transport will send it; undefined when the encoding cannot be inspected. */
function transported(response: HttpServerResponse.HttpServerResponse) {
  if (response.body._tag !== "Uint8Array") return undefined
  const bytes = response.body.body
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase()
  try {
    const plain =
      !encoding || encoding === "identity"
        ? bytes
        : encoding === "gzip"
          ? gunzipSync(bytes)
          : encoding === "deflate"
            ? inflateSync(bytes)
            : undefined
    return plain === undefined ? undefined : new TextDecoder().decode(plain)
  } catch {
    return undefined
  }
}

function isProjection(response: HttpServerResponse.HttpServerResponse) {
  const serialized = transported(response)
  if (serialized === undefined) return false
  try {
    return countsOnly(JSON.parse(serialized))
  } catch {
    return false
  }
}

/** The caller captures owner authority before returning a stream; its body must never fall back to ambient auth. */
export const session = Effect.fn("SessionAudienceHttp.session")(function* (sessionID: string, owner: boolean) {
  if (owner) return true
  const audience = yield* SessionAudience.Service
  return (yield* audience.knows(sessionID)) && !(yield* audience.isPrivate(sessionID))
})

export const directory = Effect.fn("SessionAudienceHttp.directory")(function* (directory: string, owner: boolean) {
  if (owner) return true
  const audience = yield* SessionAudience.Service
  return !(yield* audience.isPrivateDirectory(directory))
})

export const assertSession = Effect.fn("SessionAudienceHttp.assertSession")(function* (
  sessionID: string,
  owner: boolean,
) {
  if (yield* session(sessionID, owner)) return
  return yield* new ForbiddenError({ message: "This session's raw content is available only to the owner." })
})

export const assertDirectory = Effect.fn("SessionAudienceHttp.assertDirectory")(function* (
  value: string,
  owner: boolean,
) {
  if (yield* directory(value, owner)) return
  return yield* new ForbiddenError({ message: "This working directory is available only to the owner." })
})

/** Commit the non-owner input restriction before any prompt, reply, replay, wake or remote forwarding. */
export const admit = Effect.fn("SessionAudienceHttp.admit")(function* (sessionID: string, owner: boolean) {
  if (owner) return
  const audience = yield* SessionAudience.Service
  yield* audience.markGuest(sessionID).pipe(Effect.mapError((cause) => new ForbiddenError({ message: cause.message })))
})

/** Recheck a completed JSON response before transport, including list items read before a family was fenced. */
export const response = Effect.fn("SessionAudienceHttp.response")(function* (
  response: HttpServerResponse.HttpServerResponse,
  owner: boolean,
  audience: SessionAudience.Interface | undefined,
  replication = false,
  counts = false,
) {
  if (owner) return true
  if (audience)
    for (const value of Object.values(response.headers)) if (yield* audience.containsPrivateText(value)) return false
  if (response.body._tag !== "Uint8Array") return true
  const serialized = transported(response)
  if (serialized === undefined) return false
  if (audience && (yield* audience.containsPrivateText(serialized))) return false
  if (!response.body.contentType.includes("json")) return true
  const decoded = yield* Effect.try({
    try: () => ({ ok: true as const, value: JSON.parse(serialized) as unknown }),
    catch: () => new Error("Invalid JSON response"),
  }).pipe(Effect.catch(() => Effect.succeed({ ok: false as const })))
  if (!decoded.ok) return false
  const projection = counts && countsOnly(decoded.value)
  const refs = references(decoded.value)
  if ((refs.ids.size || refs.directories.size) && !audience) return false
  for (const id of refs.ids)
    if (
      !(yield* audience!.knows(id)) ||
      (!projection && (yield* audience!.isPrivate(id))) ||
      (replication && (yield* audience!.hasGuestInput(id)))
    )
      return false
  for (const directory of refs.directories) if (yield* audience!.isPrivateDirectory(directory)) return false
  return true
})

export const protectResponse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  owner: boolean,
  audience: SessionAudience.Interface | undefined,
) =>
  Effect.gen(function* () {
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const route = yield* Effect.serviceOption(HttpRouter.RouteContext)
    const replication = Option.isSome(request) && RequestOwner.replication(request.value)
    const outputOwner = owner && !replication
    const counts =
      Option.isSome(request) && Option.isSome(route) && RequestOwner.counts(request.value, route.value.route.path)
    const gate = (value?: HttpServerResponse.HttpServerResponse) =>
      Effect.gen(function* () {
        if (outputOwner || !audience) return
        const safeCounts = counts && value !== undefined && isProjection(value)
        const id = Option.isSome(route) ? route.value.params.sessionID : undefined
        if (!safeCounts && id && (yield* audience.isPrivate(id)))
          return yield* new ForbiddenError({ message: "This session's raw content is available only to the owner." })
        if (replication && id && (yield* audience.hasGuestInput(id)))
          return yield* new ForbiddenError({ message: "This session's guest-input history cannot be replicated yet." })
        if (Option.isSome(request)) {
          const query = new URL(request.value.url, "http://localhost").searchParams
          const encoded = request.value.headers["x-vector-directory"]
          const header = encoded
            ? yield* Effect.try({ try: () => decodeURIComponent(encoded), catch: () => encoded }).pipe(
                Effect.catch(() => Effect.succeed(encoded)),
              )
            : undefined
          const base = query.get("location[directory]") || query.get("directory") || header || process.cwd()
          if (Option.isSome(route))
            for (const item of RequestOwner.fileSelectors(request.value, route.value.route.path))
              if (yield* audience.overlapsPrivateDirectory(path.resolve(base, item)))
                return yield* new ForbiddenError({
                  message: "This filesystem selection includes an owner-only working directory.",
                })
          for (const item of [base, ...RequestOwner.paths(request.value)])
            if (
              (yield* audience.isPrivateDirectory(item)) ||
              (yield* audience.isPrivateDirectory(path.resolve(base, item)))
            )
              return yield* new ForbiddenError({ message: "This working directory is available only to the owner." })
        }
      })
    // HttpApiBuilder encodes typed errors outside endpoint middleware. This hook sees the final bytes on both
    // success and failure paths, after that encoder and immediately before transport.
    if (!outputOwner && audience && Option.isSome(request))
      yield* HttpEffect.appendPreResponseHandler((_request, value) =>
        Effect.gen(function* () {
          const allowed = yield* gate(value).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (allowed && (yield* response(value, outputOwner, audience, replication, counts))) return value
          return HttpServerResponse.jsonUnsafe(
            { _tag: "ForbiddenError", message: "This response contains raw content available only to the owner." },
            { status: 403 },
          )
        }),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request.value))
    const value = yield* effect.pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* gate()
          if (
            !outputOwner &&
            audience &&
            !(yield* response(
              HttpServerResponse.jsonUnsafe({ error: cause, message: String(cause) }),
              false,
              audience,
              replication,
            ))
          )
            return yield* new ForbiddenError({
              message: "This error contains raw content available only to the owner.",
            })
          return yield* Effect.fail(cause)
        }),
      ),
    )
    yield* gate(HttpServerResponse.isHttpServerResponse(value) ? value : undefined)
    if (
      HttpServerResponse.isHttpServerResponse(value) &&
      !(yield* response(value, outputOwner, audience, replication, counts))
    )
      return yield* new ForbiddenError({ message: "This response contains raw content available only to the owner." })
    return value
  })

// Events about the workspace itself (files, branch, language servers, project, tools) that a guest's app needs live.
const WORKSPACE_EVENTS = new Set([
  "file.edited",
  "file.watcher.updated",
  "vcs.branch.updated",
  "lsp.updated",
  "project.updated",
  "project.directories.updated",
  "mcp.tools.changed",
  "installation.updated",
  "installation.update-available",
  "server.instance.disposed",
  "worktree.ready",
  "worktree.failed",
  "workspace.ready",
  "workspace.failed",
  "workspace.status",
  "plugin.added",
  "model-catalog.refreshed",
  "ide.installed",
])

/**
 * Legacy sync and live V1/V2 events share this emission-time gate; unscoped raw envelopes fail closed except the
 * workspace-level events above. `relay` is the authenticated owner's own control plane relaying a remote engine's
 * events (replication marker, no forwarded guest): its unscoped events such as terminals and toasts reach the owner's
 * app under the same private-text, session and directory checks. It never applies to a guest.
 */
export const envelope = Effect.fn("SessionAudienceHttp.envelope")(function* (
  value: unknown,
  owner: boolean,
  replication = false,
  relay = false,
) {
  if (owner) return true
  const audience = yield* SessionAudience.Service
  if (yield* audience.containsPrivateText(JSON.stringify(value) ?? "")) return false
  const root = object(value)
  const payload = root.payload === undefined ? root : object(root.payload)
  const sync = object(payload.syncEvent)
  const data = object(payload.properties ?? payload.data)
  const synced = object(sync.data)
  const location = object(root.location)
  const project = object(location.project)
  const directories = [root.directory, location.directory, project.directory, data.directory, synced.directory].flatMap(
    (value) => (typeof value === "string" ? [value] : []),
  )
  for (const value of directories) if (!(yield* directory(value, false))) return false
  const ids = [
    data.sessionID,
    synced.sessionID,
    sync.aggregateID,
    root.aggregateID,
    object(root.durable).aggregateID,
  ].flatMap((value) => Option.toArray(Schema.decodeUnknownOption(SessionSchema.ID)(value)))
  if (ids.length === 0) {
    const body = payload.properties ?? payload.data
    // Workspace-level events carry no conversation content; the text and directory checks above already screened
    // their paths, and any session or directory they mention may only narrow them. Other unscoped events stay closed.
    if (relay || WORKSPACE_EVENTS.has(text(payload.type) ?? "")) {
      const refs = references(root)
      for (const id of refs.ids)
        if (!(yield* session(id, false)) || (replication && (yield* audience.hasGuestInput(id)))) return false
      for (const value of refs.directories) if (!(yield* directory(value, false))) return false
      return true
    }
    return (
      ["server.connected", "server.heartbeat"].includes(text(payload.type) ?? "") &&
      (body === undefined ||
        (body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) &&
      Object.keys(payload).every((key) => ["id", "type", "data", "properties", "location"].includes(key)) &&
      (root.payload === undefined ||
        Object.keys(root).every((key) => ["payload", "directory", "project", "workspace"].includes(key)))
    )
  }
  for (const id of new Set(ids))
    if (!(yield* session(id, false)) || (replication && (yield* audience.hasGuestInput(id)))) return false
  const refs = references([data, synced])
  for (const id of refs.ids)
    if (!(yield* session(id, false)) || (replication && (yield* audience.hasGuestInput(id)))) return false
  for (const value of refs.directories) if (!(yield* directory(value, false))) return false
  return true
})

export * as SessionAudienceHttp from "./session-audience"
