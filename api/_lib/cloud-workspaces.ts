import {
  accountId,
  parseCommand,
  parsePublicWorkspace,
  type CloudWorkspace,
} from "../../packages/cloud-workspaces/src/protocol.js"
import { signWorkspaceRequest } from "../../packages/cloud-workspaces/src/signing.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { requireAccountUser } from "./account.js"
import { ApiError, json, readJson, type ApiRequest, type ApiResponse } from "./http.js"
import { requireModelPlanUser } from "./model-plan-chat.js"
import { requireUnrevokedAccount } from "./revocation.js"

const BODY_LIMIT = 128 * 1024
const RESPONSE_LIMIT = 2 * 1024 * 1024

/**
 * Whether this deployment was ever pointed at a workspace host. Only a deployment with neither setting held no
 * workspaces; a partial setting counts, so account deletion fails and retries instead of skipping the host.
 */
export function cloudWorkspacesConfigured() {
  return Boolean(process.env.VECTOR_WORKSPACES_ORIGIN?.trim() || process.env.VECTOR_WORKSPACES_SECRET?.trim())
}

/**
 * Fence a verified account durably before deleting its identity; the host then reaps its data asynchronously. Account
 * deletion runs this as its `workspaces` erase part (codium-erase.ts), again on every retry and on the follow-up pass:
 * the host answers `closed` for an account it already closed. `deadline` (real time, ms) shortens the wait for the host
 * so the part stops inside the deletion's time budget.
 */
export async function closeCloudWorkspaces(
  accountID: string,
  fetcher: typeof fetch = fetch,
  options: { deadline?: number } = {},
) {
  if (!cloudWorkspacesConfigured()) return
  if (!accountId(accountID)) throw unavailable()
  // Cleanup remains mandatory after the pilot or public feature switch is disabled.
  const configuration = workspaceHost()
  const path = "/accounts/close"
  const body = "{}"
  const response = await fetcher(configuration.origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signWorkspaceRequest({ secret: configuration.secret, accountId: accountID, method: "POST", path, body }),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(
      options.deadline === undefined ? 30_000 : Math.max(1_000, Math.min(30_000, options.deadline - Date.now())),
    ),
  }).catch(() => {
    throw unavailable()
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw unavailable()
  }
  const result = await upstreamJson(response)
  if (!record(result) || !exact(result, ["closed"]) || result.closed !== true) throw unavailable()
  return { closed: true as const }
}

/** The website authenticates the account; only the configured private workspace host receives its signed identity. */
export async function handleCloudWorkspaces(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      response.setHeader("allow", "GET, POST")
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
    }
    if (request.url?.includes("?") || Object.keys(request.query ?? {}).length)
      throw new ApiError(400, "WORKSPACE_REQUEST_INVALID", "Workspace requests do not accept query parameters.")
    if (request.method === "POST") requireTrustedJsonRequest(request, BODY_LIMIT)
    const account = /^Bearer vct_/.test(String(request.headers.authorization ?? ""))
      ? await requireModelPlanUser(request, fetcher)
      : await requireAccountUser(request, fetcher)
    await requireUnrevokedAccount(account.id, fetcher)
    const accounts = (process.env.VECTOR_WORKSPACES_ACCOUNTS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
    const allowed =
      process.env.VECTOR_WORKSPACES_ENABLED === "true" &&
      accounts.length > 0 &&
      accounts.every(accountId) &&
      accounts.some((id) => id.toLowerCase() === account.id.toLowerCase())
    if (!allowed) {
      if (request.method === "GET") return json(response, 200, { enabled: false, workspaces: [] })
      throw new ApiError(403, "WORKSPACES_UNAVAILABLE", "Cloud workspaces are not available for this account.")
    }
    const command = request.method === "POST" ? parseWorkspaceCommand(await readJson(request, BODY_LIMIT)) : undefined
    // Engine reads use a POST envelope, but polling them must not consume the account's mutation allowance.
    const reading = request.method === "GET" || (command?.action === "engine" && command.method === "GET")
    await enforceRateLimit(request, response, {
      scope: reading ? "cloud-workspaces-read" : "cloud-workspaces-write",
      identifier: account.id,
      limit: reading ? 240 : 60,
      windowSeconds: 60,
      requirePersistent: true,
    })
    const configuration = workspaceHost()
    if (command?.action === "engine" && command.method === "POST" && command.path.endsWith("/prompt_async"))
      await enforceRateLimit(request, response, {
        scope: "cloud-workspaces-prompt",
        identifier: account.id,
        limit: 12,
        windowSeconds: 60,
        requirePersistent: true,
      })
    if (command?.action === "create")
      await enforceRateLimit(request, response, {
        scope: "cloud-workspaces-create",
        identifier: account.id,
        limit: 6,
        windowSeconds: 3600,
        requirePersistent: true,
      })
    if (command?.action === "publish")
      await enforceRateLimit(request, response, {
        scope: "cloud-workspaces-publish",
        identifier: account.id,
        limit: 6,
        windowSeconds: 3600,
        requirePersistent: true,
      })
    const path =
      !command || command.action === "create" ? "/workspaces" : `/workspaces/${command.workspaceId}/${command.action}`
    const body = !command
      ? ""
      : command.action === "create"
        ? JSON.stringify(command)
        : command.action === "engine"
          ? JSON.stringify({
              path: command.path,
              method: command.method,
              ...(command.body === undefined ? {} : { body: command.body }),
            })
          : command.action === "publish"
            ? JSON.stringify({ digest: command.digest, githubToken: command.githubToken, title: command.title })
            : "{}"
    const method = request.method
    const upstream = await fetcher(configuration.origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...signWorkspaceRequest({ secret: configuration.secret, accountId: account.id, method, path, body }),
      },
      ...(method === "POST" ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw unavailable()
    })
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {})
      throw upstreamError(upstream.status)
    }
    const value = await upstreamJson(upstream)
    if (!command) {
      if (
        !record(value) ||
        !exact(value, ["enabled", "workspaces"]) ||
        value.enabled !== true ||
        !Array.isArray(value.workspaces) ||
        value.workspaces.length > 100
      )
        throw unavailable()
      return json(response, 200, { enabled: true, workspaces: value.workspaces.map(parsePublicWorkspace) })
    }
    if (command.action === "engine") {
      // The host already restricts engine routes and fields. Messages legitimately contain the account's own code.
      return json(response, 200, value)
    }
    if (command.action === "delete") {
      if (!record(value) || !exact(value, ["deleted"]) || value.deleted !== true) throw unavailable()
      return json(response, 200, { deleted: true })
    }
    if (command.action === "changes") {
      if (
        !record(value) ||
        !exact(
          value,
          value.pullRequest === undefined ? ["workspace", "changes"] : ["workspace", "changes", "pullRequest"],
        )
      )
        throw unavailable()
      const workspace = parsePublicWorkspace(value.workspace)
      if (workspace.id !== command.workspaceId) throw unavailable()
      return json(response, 200, {
        workspace,
        changes: publicChanges(value.changes),
        ...(value.pullRequest === undefined ? {} : { pullRequest: publicPullRequest(value.pullRequest, workspace) }),
      })
    }
    if (command.action === "publish") {
      if (!record(value) || !exact(value, ["workspace", "pullRequest"])) throw unavailable()
      const workspace = parsePublicWorkspace(value.workspace)
      if (workspace.id !== command.workspaceId) throw unavailable()
      return json(response, 200, { workspace, pullRequest: publicPullRequest(value.pullRequest, workspace) })
    }
    if (!record(value) || !exact(value, ["workspace"])) throw unavailable()
    const workspace = parsePublicWorkspace(value.workspace)
    if (command.action !== "create" && workspace.id !== command.workspaceId) throw unavailable()
    return json(response, 200, { workspace })
  } catch (error) {
    // Unknown network/parser errors may contain a model key, GitHub token or private host URL. Never log or echo them.
    const safe = error instanceof ApiError ? error : unavailable()
    json(response, safe.statusCode, { error: { code: safe.code, message: safe.message } })
  }
}

function parseWorkspaceCommand(value: unknown) {
  try {
    return parseCommand(value)
  } catch {
    throw new ApiError(400, "WORKSPACE_REQUEST_INVALID", "The workspace request is invalid.")
  }
}

function workspaceHost() {
  const configured = process.env.VECTOR_WORKSPACES_ORIGIN?.trim() ?? ""
  const secret = process.env.VECTOR_WORKSPACES_SECRET ?? ""
  let origin: URL
  try {
    origin = new URL(configured)
  } catch {
    throw unavailable()
  }
  const local =
    !process.env.VERCEL_ENV &&
    ["development", "test"].includes(process.env.NODE_ENV ?? "") &&
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  if (
    (origin.protocol !== "https:" && !local) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    ![origin.origin, origin.origin + "/"].includes(configured) ||
    secret.length < 32
  )
    throw unavailable()
  return { origin: origin.origin, secret }
}

async function upstreamJson(response: Response): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
    !response.body ||
    Number(response.headers.get("content-length")) > RESPONSE_LIMIT
  )
    throw unavailable()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > RESPONSE_LIMIT) {
        void reader.cancel().catch(() => {})
        throw unavailable()
      }
      chunks.push(result.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw unavailable()
  } finally {
    reader.releaseLock()
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function publicChanges(value: unknown) {
  if (
    !record(value) ||
    !exact(value, ["digest", "diff", "files"]) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.diff !== "string" ||
    Buffer.byteLength(value.diff, "utf8") > 256 * 1024 ||
    !Array.isArray(value.files) ||
    value.files.length > 100 ||
    value.files.some(
      (file) =>
        typeof file !== "string" ||
        !file ||
        file.length > 1024 ||
        file.startsWith("/") ||
        /[\\\x00-\x1f\x7f]/.test(file) ||
        file.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    throw unavailable()
  return { digest: value.digest, diff: value.diff, files: value.files }
}

function publicPullRequest(value: unknown, workspace: CloudWorkspace) {
  if (
    !record(value) ||
    !exact(value, ["url", "branch", "commit"]) ||
    typeof value.url !== "string" ||
    !value.url.startsWith(`https://github.com/${workspace.repository}/pull/`) ||
    !/^[1-9][0-9]*$/.test(value.url.slice(`https://github.com/${workspace.repository}/pull/`.length)) ||
    value.branch !== `vector/${workspace.id}` ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.commit)
  )
    throw unavailable()
  return { url: value.url, branch: value.branch, commit: value.commit }
}

function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function unavailable() {
  return new ApiError(
    503,
    "WORKSPACE_SERVICE_UNAVAILABLE",
    "Cloud workspaces are temporarily unavailable. Please try again.",
  )
}

function upstreamError(status: number) {
  if (status === 404) return new ApiError(404, "WORKSPACE_NOT_FOUND", "This workspace could not be found.")
  if (status === 409)
    return new ApiError(
      409,
      "WORKSPACE_CONFLICT",
      "The workspace is busy or the request conflicts with its current state.",
    )
  if (status === 429)
    return new ApiError(429, "WORKSPACE_LIMIT", "The workspace limit was reached. Please try again later.")
  return unavailable()
}
