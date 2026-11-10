import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import { Option, Schema } from "effect"
import { Teams } from "../../packages/schema/src/teams.js"
import { enforceRateLimit } from "./abuse.js"
import { ApiError, json, type ApiRequest, type ApiResponse } from "./http.js"
import { requireUnrevokedCliToken } from "./revocation.js"

const decodeKeys = Schema.decodeUnknownOption(Teams.Keys, { onExcessProperty: "error" })
const decodeAccount = Schema.decodeUnknownOption(Teams.Payload.fields.account, { onExcessProperty: "error" })
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    status: Schema.Literals(["ok", "denied", "account_missing", "invalid", "limit", "unavailable"]),
    orgs: Teams.Payload.fields.orgs,
    active: Teams.Payload.fields.active,
  }),
  { onExcessProperty: "error" },
)

export function createTeamsApi(
  input: { request?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number } = {},
) {
  const request = input.request ?? fetch
  const now = input.now ?? Date.now

  async function keys(incoming: ApiRequest, outgoing: ApiResponse) {
    get(incoming)
    if (new URL(incoming.url ?? "/", "https://vectordev.ai").search) throw invalid()
    const configuration = signingConfiguration()
    await limit(incoming, outgoing, "teams-keys", 120)
    json(outgoing, 200, configuration.keys)
  }

  async function config(incoming: ApiRequest, outgoing: ApiResponse) {
    get(incoming)
    const configuration = signingConfiguration()
    const query = new URL(incoming.url ?? "/", "https://vectordev.ai").searchParams
    if ([...query.keys()].some((key) => key !== "org") || query.getAll("org").length > 1) throw invalid()
    const org = query.get("org") ?? undefined
    if (org !== undefined && !Schema.is(Teams.ID)(org)) throw invalid()
    await limit(incoming, outgoing, "teams-config-ip", 60)
    const authorization = incoming.headers.authorization
    const token =
      typeof authorization === "string" && authorization.length <= 16_384
        ? /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)?.[1]
        : undefined
    if (!token) throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to Vector to load team configuration.")
    const claims = await requireUnrevokedCliToken(token, fetch, now())
    const account = Option.getOrUndefined(decodeAccount({ id: claims.id, email: claims.email }))
    if (!account) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
    await limit(incoming, outgoing, "teams-config-account", 60, account.id)
    const row = await readConfiguration(account.id, org)
    await requireUnrevokedCliToken(token, fetch, now())
    const issuedAt = now()
    // Do not keep policy usable past the already-verified CLI grant's expiry.
    const grant = JSON.parse(Buffer.from(token.slice(4).split(".")[0]!, "base64url").toString("utf8")) as {
      exp: number
    }
    const expiresAt = Math.min(issuedAt + Teams.MAX_AGE_MS, grant.exp)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt)
      throw new ApiError(401, "CLI_TOKEN_EXPIRED", "Sign in to Vector again to continue.")
    const payload: Teams.Payload = {
      version: 1,
      issuer: "https://vectordev.ai",
      audience: "vector-teams",
      account,
      credentialHash: createHash("sha256").update(token).digest("hex"),
      issuedAt,
      expiresAt,
      orgs: row.orgs,
      active: row.active,
    }
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
    const envelope: Teams.Envelope = {
      version: 1,
      keyId: configuration.keyId,
      payload: encoded,
      signature: sign(null, Buffer.from(`vector-org-config-v1.${encoded}`, "utf8"), configuration.privateKey).toString(
        "base64url",
      ),
    }
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > Teams.MAX_RESPONSE_BYTES) throw unavailable()
    json(outgoing, 200, envelope)
  }

  async function readConfiguration(accountID: string, orgID?: string) {
    const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "")
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
    const origin = url ? URL.parse(url) : null
    const local =
      process.env.NODE_ENV !== "production" &&
      process.env.VERCEL_ENV !== "production" &&
      origin?.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
    if (
      !url ||
      !key ||
      !origin ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !local)
    )
      throw unavailable()
    const response = await request(`${url}/rest/v1/rpc/vector_team_configuration`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({ request: { accountID, ...(orgID ? { orgID } : {}) } }),
    }).catch(() => undefined)
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => undefined)
      throw unavailable()
    }
    const raw: unknown = await boundedJson(response)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unavailable()
    const status = "status" in raw ? raw.status : undefined
    if (status === "denied")
      throw new ApiError(403, "TEAM_ACCESS_DENIED", "You are no longer a member of that Vector team.")
    if (status === "account_missing")
      throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
    if (status !== "ok") throw unavailable()
    const active = "active" in raw ? raw.active : undefined
    if (
      active !== null &&
      (!active || typeof active !== "object" || !("config" in active) || !Teams.isConfig(active.config))
    )
      throw unavailable()
    const row = Option.getOrUndefined(decodeRow(raw))
    if (
      !row ||
      new Set(row.orgs.map((org) => org.id)).size !== row.orgs.length ||
      (orgID === undefined && row.active !== null) ||
      (orgID !== undefined && (row.active?.id !== orgID || !row.orgs.some((org) => org.id === orgID)))
    )
      throw unavailable()
    return row
  }

  return { keys: safe(keys), config: safe(config) }
}

function signingConfiguration() {
  if (
    process.env.VECTOR_TEAMS_ENABLED !== "true" ||
    (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production")
  )
    throw notConfigured()
  const keyId = process.env.VECTOR_TEAMS_SIGNING_KEY_ID ?? ""
  const pem = (process.env.VECTOR_TEAMS_SIGNING_PRIVATE_KEY ?? "").replaceAll("\\n", "\n")
  const previous = process.env.VECTOR_TEAMS_PREVIOUS_PUBLIC_KEYS ?? "[]"
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
    pem.length > 16_384 ||
    !pem.startsWith("-----BEGIN PRIVATE KEY-----") ||
    previous.length > 10_000
  )
    throw notConfigured()
  try {
    const privateKey = createPrivateKey(pem)
    if (privateKey.asymmetricKeyType !== "ed25519") throw notConfigured()
    const old: unknown = JSON.parse(previous)
    if (!Array.isArray(old)) throw notConfigured()
    const keys = Option.getOrUndefined(
      decodeKeys({
        keys: [
          {
            id: keyId,
            publicKey: createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url"),
          },
          ...old,
        ],
      }),
    )
    if (!keys || new Set(keys.keys.map((key) => key.id)).size !== keys.keys.length) throw notConfigured()
    for (const item of keys.keys) {
      const publicKey = createPublicKey({ key: Buffer.from(item.publicKey, "base64url"), type: "spki", format: "der" })
      if (
        publicKey.asymmetricKeyType !== "ed25519" ||
        publicKey.export({ type: "spki", format: "der" }).toString("base64url") !== item.publicKey
      )
        throw notConfigured()
    }
    return { keyId, privateKey, keys }
  } catch {
    throw notConfigured()
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw unavailable()
  const chunks: Uint8Array[] = []
  const state = { bytes: 0 }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      state.bytes += chunk.value.byteLength
      if (state.bytes > Teams.MAX_RESPONSE_BYTES) throw unavailable()
      chunks.push(chunk.value)
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function get(request: ApiRequest) {
  if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for team configuration.")
  if (Number(request.headers["content-length"] ?? 0) !== 0 || request.headers["transfer-encoding"]) throw invalid()
}

function limit(request: ApiRequest, response: ApiResponse, scope: string, count: number, identifier?: string) {
  return enforceRateLimit(request, response, {
    scope,
    limit: count,
    windowSeconds: 60,
    identifier,
    requirePersistent: true,
  })
}

function safe(handler: (request: ApiRequest, response: ApiResponse) => Promise<void>) {
  return async (request: ApiRequest, response: ApiResponse) => {
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("referrer-policy", "no-referrer")
    await handler(request, response).catch((error: unknown) => {
      request.resume()
      const known = error instanceof ApiError ? error : unavailable()
      json(response, known.statusCode, {
        error: {
          code: known.code === "ABUSE_PROTECTION_UNAVAILABLE" ? "PERSISTENT_STORE_UNAVAILABLE" : known.code,
          message: known.message,
        },
      })
    })
  }
}

function invalid() {
  return new ApiError(400, "TEAMS_INVALID", "Choose a valid Vector team without extra request fields.")
}
function unavailable() {
  return new ApiError(
    503,
    "TEAMS_UNAVAILABLE",
    "Vector could not verify the team configuration. Try again before continuing in that team.",
  )
}
function notConfigured() {
  return new ApiError(503, "TEAMS_NOT_CONFIGURED", "Vector Teams is not enabled or configured.")
}

export const teamsApi = createTeamsApi()
