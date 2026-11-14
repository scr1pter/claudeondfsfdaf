import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

export function forwarded(request: HttpServerRequest.HttpServerRequest) {
  return request.headers[GUEST_REQUEST_HEADER]?.split(",").some((value) => value.trim() === "1") === true
}

export const REPLICATION_HEADER = "x-vector-session-replication"

/** This marker only narrows output; it never changes the credential principal or grants authority. */
export function replication(request: HttpServerRequest.HttpServerRequest) {
  return request.headers[REPLICATION_HEADER]?.split(",").some((value) => value.trim() === "1") === true
}

export const TRANSFER_HEADER = "x-vector-session-transfer"

/**
 * A session warp names the conversation it moves. Replication omits a restricted conversation from history, but refuses
 * the request when the named one is restricted. Like the replication marker, it only narrows output.
 */
export function transfer(request: HttpServerRequest.HttpServerRequest) {
  return request.headers[TRANSFER_HEADER]?.trim() || undefined
}

export function replicationHeaders(input: HeadersInit | undefined, transfer?: string) {
  const headers = new Headers(input)
  headers.set(REPLICATION_HEADER, "1")
  if (transfer) headers.set(TRANSFER_HEADER, transfer)
  return headers
}

/** This exact server operation returns a validated counts projection; raw session routes have no exception. */
export function counts(request: HttpServerRequest.HttpServerRequest, template: string) {
  return request.method === "GET" && template === "/experimental/session/:sessionID/tasks/:taskID/changes"
}

export function relayHeaders(input: HeadersInit | undefined) {
  const headers = new Headers(input)
  headers.set(GUEST_REQUEST_HEADER, "1")
  return [...headers.entries()]
}

/** Forwarded guest requests authenticate with owner credentials; the restriction header only removes authority. */
export const owner = Effect.gen(function* () {
  const principal = yield* RequestPrincipal
  const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
  return principal.kind === "owner" && (!Option.isSome(request) || !forwarded(request.value))
})

/** Path selectors are checked before resolving an instance, even when an endpoint would ignore a supplied selector. */
export function paths(request: HttpServerRequest.HttpServerRequest) {
  const query = new URL(request.url, "http://localhost").searchParams
  return [...query].flatMap(([key, value]) =>
    ["directory", "location[directory]", "path", "file", "filepath"].includes(key) ? [value] : [],
  )
}

/** Raw filesystem reads can traverse descendants, unlike an ordinary session's routing directory. */
export function fileSelectors(request: HttpServerRequest.HttpServerRequest, template: string) {
  if (template === "/api/fs/read/*")
    return [decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(13))]
  if (
    ![
      "/file",
      "/file/content",
      "/file/status",
      "/find",
      "/find/file",
      "/find/symbol",
      "/api/fs/list",
      "/api/fs/find",
    ].includes(template)
  )
    return []
  const query = new URL(request.url, "http://localhost").searchParams
  return [query.get("path") ?? ""]
}

export * as RequestOwner from "./request-owner"
