import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { PublicSession } from "../../packages/schema/src/public-session.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { ApiError, json, readJson, type ApiRequest, type ApiResponse } from "./http.js"
import { requireUnrevokedAccount, requireUnrevokedCliToken } from "./revocation.js"

const decodeCreate = Schema.decodeUnknownOption(PublicSession.Create, { onExcessProperty: "error" })
const decodeUpdate = Schema.decodeUnknownOption(PublicSession.Update, { onExcessProperty: "error" })
const decodeDelete = Schema.decodeUnknownOption(Schema.Struct({ secret: PublicSession.Secret }), {
  onExcessProperty: "error",
})
const decodeSnapshot = Schema.decodeUnknownOption(PublicSession.Snapshot, { onExcessProperty: "error" })
const decodeInfo = Schema.decodeUnknownOption(PublicSession.Info, { onExcessProperty: "error" })
const Row = Schema.Struct({
  status: Schema.Literals(["ok", "not_found", "conflict", "limit"]),
  owner: Schema.NullOr(Schema.String),
  info: Schema.NullOr(Schema.Json),
  archive: Schema.NullOr(Schema.Json),
})
const decodeRow = Schema.decodeUnknownOption(Row)
const unavailable = () =>
  new ApiError(
    503,
    "SHARES_UNAVAILABLE",
    "Vector could not confirm the share operation. Try again; an existing link may still be public.",
  )
const notFound = () => new ApiError(404, "SHARE_NOT_FOUND", "This public session has expired or was removed.")

export async function cleanupPublicShares() {
  await store({ action: "cleanup" })
}

export async function publicShares(request: ApiRequest, response: ApiResponse, id?: string) {
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
  response.setHeader("referrer-policy", "no-referrer")
  const method = request.method
  if (!id && method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST to publish a session.")
  if (id && !/^[a-f0-9]{32}$/.test(id)) throw notFound()
  if (id && method !== "GET" && method !== "PUT" && method !== "DELETE")
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, PUT or DELETE for a public session.")

  if (method === "GET" && id) {
    await limit(request, response, "share-read", 120, 60)
    const row = await store({ action: "read", id })
    if (!row.owner) throw notFound()
    await requireUnrevokedAccount(row.owner).catch((error: unknown) => {
      if (error instanceof ApiError && error.statusCode === 401) throw notFound()
      throw error
    })
    const snapshot = Option.getOrUndefined(decodeSnapshot({ ...record(row.info), archive: row.archive }))
    if (!snapshot || snapshot.id !== id || snapshot.expiresAt <= Date.now()) throw notFound()
    json(response, 200, snapshot)
    return
  }

  requireTrustedJsonRequest(request, PublicSession.MAX_BYTES)
  const token = /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1]
  if (!token) throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to Vector to publish or remove a public session.")
  const user = await requireUnrevokedCliToken(token)
  await limit(request, response, "share-write", 60, 60, user.id)
  const body = await readJson<unknown>(request, PublicSession.MAX_BYTES)

  if (method === "POST") {
    const input = Option.getOrUndefined(decodeCreate(body))
    if (!input)
      throw new ApiError(400, "SHARE_INVALID", "Review the public-sharing consent and session before publishing.")
    if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + PublicSession.MAX_AGE_MS)
      throw new ApiError(400, "SHARE_EXPIRY_INVALID", "Choose an expiry within the next 30 days.")
    await limit(request, response, "share-create", 20, 86_400, user.id)
    const row = await store({
      action: "create",
      id: input.id,
      owner: user.id,
      secret: digest(input.secret),
      archive: input.archive,
      expiresAt: input.expiresAt,
      updates: input.consent.updates,
      consentVersion: input.consent.version,
    })
    json(response, 200, info(row.info, input.id))
    return
  }

  if (method === "PUT" && id) {
    const input = Option.getOrUndefined(decodeUpdate(body))
    if (!input) throw new ApiError(400, "SHARE_INVALID", "The public session update is not valid.")
    const row = await store({
      action: "update",
      id,
      owner: user.id,
      secret: digest(input.secret),
      archive: input.archive,
      revision: input.revision,
    })
    json(response, 200, info(row.info, id))
    return
  }

  const input = Option.getOrUndefined(decodeDelete(body))
  if (!input || !id) throw new ApiError(400, "SHARE_INVALID", "The public session removal is not valid.")
  await store({ action: "delete", id, owner: user.id, secret: digest(input.secret) })
  json(response, 200, { deleted: true })
}

function limit(
  request: ApiRequest,
  response: ApiResponse,
  scope: string,
  count: number,
  seconds: number,
  identifier?: string,
) {
  return enforceRateLimit(request, response, {
    scope,
    limit: count,
    windowSeconds: seconds,
    identifier,
    requirePersistent: true,
  })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function info(value: unknown, id: string) {
  const result = Option.getOrUndefined(decodeInfo(value))
  if (!result || result.id !== id) throw unavailable()
  return result
}

function digest(secret: string) {
  return createHash("sha256").update(secret).digest("hex")
}

async function store(input: Record<string, unknown>) {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "")
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw unavailable()
  const origin = URL.parse(url)
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    origin?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    !origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !local)
  )
    throw unavailable()
  const response = await fetch(`${url}/rest/v1/rpc/vector_public_share`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ request: input }),
  }).catch(() => undefined)
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    throw unavailable()
  }
  const payload = await boundedJson(response).catch(() => {
    throw unavailable()
  })
  const row = Option.getOrUndefined(decodeRow(payload))
  if (!row) throw unavailable()
  if (row.status === "not_found") throw notFound()
  if (row.status === "conflict")
    throw new ApiError(
      409,
      "SHARE_CONFLICT",
      "This public session changed or was removed. Refresh its status before retrying.",
    )
  if (row.status === "limit")
    throw new ApiError(429, "SHARE_LIMIT", "Remove an existing public session before publishing another.")
  return row
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw unavailable()
  const chunks: Uint8Array[] = []
  const state = { bytes: 0 }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.bytes += next.value.byteLength
    if (state.bytes > 8_000_000) {
      await reader.cancel().catch(() => undefined)
      throw unavailable()
    }
    chunks.push(next.value)
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString("utf8")),
  )
}
