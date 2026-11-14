import { createPrivateKey, randomBytes } from "node:crypto"
import { importPKCS8, SignJWT } from "jose"
import { codiumKey } from "./codium-keys.js"
import { githubAppConfiguration, type GithubAppConfiguration } from "./github-app.js"
import { githubApiVersion, githubResponseBytes } from "./github-http.js"
import { ApiError } from "./http.js"
import { appendAudit } from "./ops-records.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Vector's own server use of its GitHub App (WP A48): one-repository installation tokens for Release Guard, minted on
 * the server, used for one task, revoked as soon as it ends and written to the account's audit log. Nothing else on the
 * server holds an App credential, and the server never merges (S9): the only writes a token here can make are a revert
 * pull request, or a branch with one restore commit and its pull request (release-guard.ts decides which, and re-reads
 * the repository's .vector/ops.json before writing).
 *
 * Three kinds of token:
 * - `check`: Contents and Metadata read. Release Guard's intake reads .vector/ops.json with it before watching a release.
 * - `revert`: Contents and Pull requests write, Metadata read. Only the revert path mints it.
 * - `ship`: Checks, Contents and Metadata read. Ship Desk (WP A49) reads the opt-in and a pull request's check runs.
 *
 * Each token is minted for exactly one repository id, its permissions are compared with what was asked, and the
 * repository it can see is checked to be that one before it is used (the same checks api/_lib/github-app.ts makes for
 * the Actions exchange). The token never leaves this module: callers get a client that sends requests to that one
 * repository. GitHub's App settings stay the owner's (docs/vector/owner-actions/github-app.md); the App is used here only
 * on production (`githubAppConfiguration`).
 */

export const GITHUB_SERVER_PERMISSIONS = {
  check: { contents: "read", metadata: "read" },
  revert: { contents: "write", metadata: "read", pull_requests: "write" },
  // WP A49, Ship Desk: reads .vector/ops.json on the pull request's base branch and the head commit's check runs.
  ship: { checks: "read", contents: "read", metadata: "read" },
} as const
export type GithubServerPurpose = keyof typeof GITHUB_SERVER_PERMISSIONS

export const GITHUB_SERVER_LIMITS = {
  /** Each request to GitHub. */
  requestMs: 8_000,
  /** Answers larger than this are refused. */
  answerBytes: 1_000_000,
  /** Audit entries kept per account, and for how long. */
  auditEntries: 200,
  auditMs: 90 * 24 * 60 * 60_000,
} as const

const API = "https://api.github.com"
const TOKEN = /^[A-Za-z0-9_]{20,2048}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const PATH = /^\/[A-Za-z0-9._~\-/%:@!$&'()*+,;=?]*$/

/** Why a call to GitHub did not give an answer. */
export type GithubFailureKind =
  /** GitHub could not be reached, timed out, rate limited us or failed (5xx): try again later. */
  | "unavailable"
  /** GitHub refused (403, 401 with a fresh token): no point trying again with the same request. */
  | "refused"
  /** 404. */
  | "missing"
  /** 409 or 422: a conflict, such as a branch or pull request that already exists. */
  | "conflict"
  /** The App is not set up on this server, or not installed on the repository. */
  | "not-installed"

export class GithubServerError extends Error {
  constructor(
    readonly kind: GithubFailureKind,
    readonly status?: number,
  ) {
    super(`GitHub ${kind}${status ? ` (${status})` : ""}`)
  }
}

export function githubServerError(error: unknown): error is GithubServerError {
  return error instanceof GithubServerError
}

/** The repository a token can see, as GitHub reported it when the token was checked. */
export type GithubRepository = {
  id: number
  fullName: string
  defaultBranch: string
  private: boolean
}

export type GithubWrite = { kind: string; number?: number; ref?: string }

/** Requests to the one repository a token was minted for. Paths are relative to `/repos/<owner>/<name>`. */
export type GithubRepoClient = {
  readonly repository: GithubRepository
  readonly purpose: GithubServerPurpose
  /** GET; undefined for 404. */
  get(path: string): Promise<unknown>
  /** A write (POST, PATCH, PUT, DELETE) inside the repository; recorded in the audit log when it succeeds. */
  write(method: "POST" | "PATCH", path: string, body: unknown, audit: GithubWrite): Promise<unknown>
  /** A GraphQL mutation or query; recorded in the audit log when `audit` is given and it succeeds. */
  graphql(query: string, variables: Record<string, unknown>, audit?: GithubWrite): Promise<Record<string, unknown>>
}

export type GithubServerOptions = {
  fetcher?: typeof fetch
  now?: number
  configuration?: () => GithubAppConfiguration | undefined
}

/** Whether the App is set up on this server (production, with every App setting). */
export function githubServerConfigured(configuration = githubAppConfiguration) {
  try {
    return configuration() !== undefined
  } catch {
    return false
  }
}

export const githubAuditKey = (account: string) => codiumKey("ops", "audit", account)

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function positive(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

/** One request to GitHub's API. The answer's body, parsed, or a GithubServerError. */
async function send(
  fetcher: typeof fetch,
  input: { method: string; url: string; token: string; body?: unknown; accept?: string },
): Promise<{ status: number; body: unknown }> {
  let response: Response
  try {
    response = await fetcher(input.url, {
      method: input.method,
      headers: {
        accept: input.accept ?? "application/vnd.github+json",
        "x-github-api-version": githubApiVersion,
        "user-agent": "Vector/Release-Guard",
        authorization: `Bearer ${input.token}`,
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_SERVER_LIMITS.requestMs),
      cache: "no-store",
    })
  } catch {
    throw new GithubServerError("unavailable")
  }
  const status = response.status
  if (status === 204) {
    await response.body?.cancel().catch(() => undefined)
    return { status, body: undefined }
  }
  if (status < 200 || status >= 300) {
    const limited =
      status === 429 ||
      status >= 500 ||
      response.headers.get("retry-after") !== null ||
      response.headers.get("x-ratelimit-remaining") === "0"
    await response.body?.cancel().catch(() => undefined)
    if (limited) throw new GithubServerError("unavailable", status)
    if (status === 404) throw new GithubServerError("missing", status)
    if (status === 409 || status === 422) throw new GithubServerError("conflict", status)
    if (status === 401) throw new GithubServerError("unavailable", status)
    throw new GithubServerError("refused", status)
  }
  let bytes: Uint8Array
  try {
    bytes = await githubResponseBytes(response, GITHUB_SERVER_LIMITS.answerBytes)
  } catch {
    throw new GithubServerError("unavailable", status)
  }
  if (!bytes.length) return { status, body: undefined }
  try {
    return { status, body: JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown }
  } catch {
    throw new GithubServerError("unavailable", status)
  }
}

async function appJwt(config: GithubAppConfiguration, now: number) {
  let pem: string
  try {
    const key = createPrivateKey(config.privateKey)
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new GithubServerError("not-installed")
    pem = key.export({ type: "pkcs8", format: "pem" }).toString()
  } catch {
    throw new GithubServerError("not-installed")
  }
  const seconds = Math.floor(now / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.clientId)
    .setIssuedAt(seconds - 60)
    .setExpirationTime(seconds + 300)
    .sign(await importPKCS8(pem, "RS256"))
    .catch(() => {
      throw new GithubServerError("not-installed")
    })
}

function samePermissions(granted: unknown, wanted: Readonly<Record<string, string>>) {
  const value = record(granted)
  if (!value) return false
  return (
    Object.keys(value).length === Object.keys(wanted).length &&
    Object.entries(wanted).every(([name, level]) => value[name] === level)
  )
}

/**
 * Mints a token for one repository, runs `use` with a client for it, then revokes the token and writes the audit
 * entry, whatever `use` did. `installationId` is the App installation when it is known (from the delivery or the
 * binding); otherwise it is looked up by the repository's full name. GitHub being unreachable is "unavailable"; the App
 * missing on this server or on the repository is "not-installed".
 */
export async function withRepositoryToken<T>(
  input: {
    account: string
    repositoryId: number
    /** owner/name, used only to find the installation when its id is not known. */
    repository?: string
    installationId?: number
    purpose: GithubServerPurpose
    /** Why the token was minted (the audit's reason, such as "opt-in" or "revert"). */
    reason: string
  },
  use: (client: GithubRepoClient) => Promise<T>,
  options: GithubServerOptions = {},
): Promise<T> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  let config: GithubAppConfiguration | undefined
  try {
    config = (options.configuration ?? githubAppConfiguration)()
  } catch {
    config = undefined
  }
  if (!config) throw new GithubServerError("not-installed")
  if (!positive(input.repositoryId)) throw new GithubServerError("not-installed")
  const permissions = GITHUB_SERVER_PERMISSIONS[input.purpose]
  const jwt = await appJwt(config, now)

  let installationId = positive(input.installationId)
  if (!installationId) {
    if (!input.repository || !REPOSITORY.test(input.repository)) throw new GithubServerError("not-installed")
    const found = await send(fetcher, {
      method: "GET",
      url: `${API}/repos/${input.repository}/installation`,
      token: jwt,
    })
      .then((answer) => record(answer.body))
      .catch((error: unknown) => {
        if (githubServerError(error) && (error.kind === "missing" || error.kind === "refused"))
          throw new GithubServerError("not-installed", error.status)
        throw error
      })
    if (String(found?.app_id) !== config.id || !positive(found?.id)) throw new GithubServerError("not-installed")
    installationId = found!.id as number
  }

  // No token is minted without a record of it: the entry is written first (a store that cannot be reached stops here),
  // and completed with what the token did once it is revoked.
  const auditId = randomBytes(8).toString("base64url")
  const audit = {
    v: 1,
    id: auditId,
    at: now,
    purpose: input.purpose,
    reason: input.reason,
    repositoryId: input.repositoryId,
    installationId,
  }
  const auditInput = { at: now, max: GITHUB_SERVER_LIMITS.auditEntries, keepMs: GITHUB_SERVER_LIMITS.auditMs }
  await appendAudit(githubAuditKey(input.account), { ...audit, state: "minting" }, auditInput, fetcher)

  const minted = await send(fetcher, {
    method: "POST",
    url: `${API}/app/installations/${installationId}/access_tokens`,
    token: jwt,
    body: { repository_ids: [input.repositoryId], permissions },
  }).catch((error: unknown) => {
    // The installation is gone, or does not include the repository, or lost a permission.
    if (githubServerError(error) && error.kind !== "unavailable")
      throw new GithubServerError("not-installed", error.status)
    throw error
  })
  const body = record(minted.body)
  const token = typeof body?.token === "string" && TOKEN.test(body.token) ? body.token : undefined
  if (!token) throw new GithubServerError("unavailable")

  const writes: GithubWrite[] = []
  let outcome: "ok" | "failed" = "failed"
  let revoked = false
  let repositoryName: string | undefined
  try {
    const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 3_660_000)
      throw new GithubServerError("unavailable")
    if (!samePermissions(body?.permissions, permissions)) throw new GithubServerError("refused")
    // The token must see exactly the one repository it was minted for.
    const scope = record(
      (await send(fetcher, { method: "GET", url: `${API}/installation/repositories?per_page=2`, token })).body,
    )
    const list = Array.isArray(scope?.repositories) ? scope.repositories : []
    const repo = record(list[0])
    if (scope?.total_count !== 1 || list.length !== 1 || positive(repo?.id) !== input.repositoryId)
      throw new GithubServerError("refused")
    if (typeof repo?.full_name !== "string" || !REPOSITORY.test(repo.full_name)) throw new GithubServerError("refused")
    if (repo.archived === true || repo.disabled === true) throw new GithubServerError("refused")
    const defaultBranch = typeof repo.default_branch === "string" && repo.default_branch ? repo.default_branch : "main"
    const repository: GithubRepository = {
      id: input.repositoryId,
      fullName: repo.full_name,
      defaultBranch,
      private: repo.private === true,
    }
    repositoryName = repository.fullName
    const root = `${API}/repos/${repository.fullName}`
    const checkPath = (path: string) => {
      if (!PATH.test(path) || path.includes("/../") || path.endsWith("/..") || path.startsWith("//"))
        throw new GithubServerError("refused")
      return `${root}${path}`
    }
    const client: GithubRepoClient = {
      repository,
      purpose: input.purpose,
      async get(path) {
        try {
          return (await send(fetcher, { method: "GET", url: checkPath(path), token })).body
        } catch (error) {
          if (githubServerError(error) && error.kind === "missing") return undefined
          throw error
        }
      },
      async write(method, path, payload, audit) {
        if (input.purpose !== "revert") throw new GithubServerError("refused")
        const answer = await send(fetcher, { method, url: checkPath(path), token, body: payload })
        writes.push(audit)
        return answer.body
      },
      async graphql(query, variables, audit) {
        if (audit && input.purpose !== "revert") throw new GithubServerError("refused")
        const answer = record(
          (await send(fetcher, { method: "POST", url: `${API}/graphql`, token, body: { query, variables } })).body,
        )
        if (!answer) throw new GithubServerError("unavailable")
        if (Array.isArray(answer.errors) && answer.errors.length) throw new GithubServerError("refused")
        const data = record(answer.data)
        if (!data) throw new GithubServerError("unavailable")
        if (audit) writes.push(audit)
        return data
      },
    }
    const result = await use(client)
    outcome = "ok"
    return result
  } finally {
    // The token is never kept: revoked as soon as the task ends, whatever happened. A failed revoke is recorded; the
    // token then expires within the hour GitHub gives it.
    revoked = await send(fetcher, { method: "DELETE", url: `${API}/installation/token`, token })
      .then(() => true)
      .catch(() => false)
    await appendAudit(
      githubAuditKey(input.account),
      {
        ...audit,
        state: "done",
        ...(repositoryName ? { repository: repositoryName } : {}),
        writes,
        revoked,
        outcome,
      },
      // Scored after the "minting" entry, so the newest entry for an id is its last.
      { ...auditInput, at: now + 1 },
      fetcher,
    ).catch(() => undefined)
  }
}

/** The account's App audit log, newest first (the owner's incident response and the account's own screens). */
export async function readGithubAudit(account: string, fetcher: typeof fetch = fetch, limit = 50) {
  const result = await persistentStore(["ZREVRANGE", githubAuditKey(account), "0", String(limit * 2 - 1)], fetcher)
  if (!Array.isArray(result)) throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "The audit log could not be read.")
  const seen = new Set<string>()
  return result.flatMap((entry) => {
    let value: Record<string, unknown> | undefined
    try {
      value = record(JSON.parse(String(entry)))
    } catch {
      return []
    }
    // Each token has a "minting" entry and, once revoked, a "done" one; the newest is kept.
    if (!value || typeof value.id !== "string" || seen.has(value.id)) return []
    seen.add(value.id)
    return [value]
  })
}
