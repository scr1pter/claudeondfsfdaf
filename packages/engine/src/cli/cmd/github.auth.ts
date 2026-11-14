import { getIDToken, setSecret } from "@actions/core"
import { z } from "zod"
import { githubFetch } from "./github.shared"

export const GITHUB_APP_TOKEN_URL = "https://vectordev.ai/api/github/token"
export const GITHUB_ACTIONS_BOT = "github-actions[bot]"

const permissions = {
  task: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "write",
    checks: "read",
    metadata: "read",
  },
  review: { contents: "read", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
  publish: { contents: "write", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
} as const

const Token = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/)
const Installation = z
  .object({
    token: Token,
    expiresAt: z.string().datetime(),
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    repository: z.string(),
    permissions: z.record(z.string(), z.string()),
    bot: z
      .object({
        login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}\[bot\]$/),
        id: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict()

export type GithubAuth = {
  source: "github" | "app"
  token: string
  repository: string
  botLogin: string
  botId?: number
  expiresAt?: string
  dispose: () => Promise<void>
}

type Services = {
  oidc: (audience: string) => Promise<string>
  mask: (value: string) => void
  request: (url: string, init: RequestInit) => Promise<Response>
}

/** A Vector account token cannot authorize a GitHub repository. Only Actions OIDC can exchange for App access. */
export async function resolveGithubAuth(
  input: {
    purpose: "task" | "review" | "publish"
    repository: string
    pullRequest?: number
    providedToken?: string
    env?: Record<string, string | undefined>
    notice?: (message: string) => void
    signal?: AbortSignal
  },
  services: Services = {
    oidc: getIDToken,
    mask: (value) => {
      // Workflow commands contain the secret verbatim. A local terminal cannot
      // interpret them as masking instructions, so it must never receive one.
      if (process.env.GITHUB_ACTIONS === "true") setSecret(value)
    },
    // The App token exchange and its revocation are the github source's, so Vector Local decides them.
    request: githubFetch,
  },
): Promise<GithubAuth> {
  const env = input.env ?? process.env
  const mode = env.USE_GITHUB_TOKEN === "true" ? "github" : (env.VECTOR_GITHUB_AUTH ?? "github")
  if (!["github", "auto", "app"].includes(mode)) throw new Error("VECTOR_GITHUB_AUTH must be github, auto or app.")
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository))
    throw new Error("GitHub authentication requires the exact owner/repository.")
  if (input.pullRequest !== undefined && (!Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0))
    throw new Error("The GitHub pull request number is invalid.")
  const fallback = (reason?: string): GithubAuth => {
    if (reason && mode === "app") throw new Error(reason)
    const token = Token.safeParse(input.providedToken ?? env.GITHUB_TOKEN)
    if (!token.success) throw new Error("GITHUB_TOKEN is not set. Provide the repository Actions token.")
    services.mask(token.data)
    if (reason) input.notice?.(`${reason} Continuing with the repository GITHUB_TOKEN.`)
    return {
      source: "github",
      token: token.data,
      repository: input.repository,
      botLogin: GITHUB_ACTIONS_BOT,
      dispose: async () => {},
    }
  }
  if (input.providedToken || mode === "github") return fallback()
  if (
    env.GITHUB_ACTIONS !== "true" ||
    (env.GITHUB_SERVER_URL && env.GITHUB_SERVER_URL !== "https://github.com") ||
    (env.GITHUB_API_URL && env.GITHUB_API_URL !== "https://api.github.com") ||
    !["issue_comment", "issues", "workflow_dispatch", "schedule"].includes(env.GITHUB_EVENT_NAME ?? "")
  )
    return fallback("Vector App authentication is unavailable for this workflow event or GitHub host.")
  if (env.GITHUB_REPOSITORY !== input.repository || !/^[1-9][0-9]*$/.test(env.GITHUB_REPOSITORY_ID ?? ""))
    throw new Error("The GitHub workflow repository identity does not match the requested repository.")
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    return fallback("This workflow has no Actions OIDC permission. Run vector github install to update it.")
  input.signal?.throwIfAborted()
  const oidc = await services.oidc(GITHUB_APP_TOKEN_URL).catch(() => {
    // Never expose the SDK exception: it may contain an authenticated request.
    throw new Error("GitHub could not supply the Actions identity token. Retry the workflow.")
  })
  services.mask(oidc)
  input.signal?.throwIfAborted()
  const response = await services
    .request(GITHUB_APP_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${oidc}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: input.purpose,
        ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
      }),
      redirect: "error",
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    })
    .catch(() => undefined)
  if (!response) {
    input.signal?.throwIfAborted()
    return fallback("The Vector GitHub App service is unavailable.")
  }
  const body = await readBody(response)
  if (!response.ok) {
    const failure = z.object({ error: z.object({ code: z.string() }) }).safeParse(body)
    const code = failure.success ? failure.data.error.code : "GITHUB_UNAVAILABLE"
    if (
      (response.status === 404 && code === "APP_NOT_INSTALLED") ||
      (response.status === 503 &&
        ["GITHUB_APP_NOT_CONFIGURED", "GITHUB_UNAVAILABLE", "PERSISTENT_STORE_UNAVAILABLE"].includes(code))
    )
      return fallback("The Vector GitHub App is not installed or its service is unavailable.")
    // Invalid, replayed or policy-denied proof is never an automatic downgrade.
    throw new Error(
      "Vector GitHub App authorization was denied. Check the installation, workflow and actor permissions.",
    )
  }
  const parsed = Installation.safeParse(body)
  // Mask and revoke even a malformed successful response if it contains a usable token.
  const candidate = z.object({ token: Token }).safeParse(body)
  if (candidate.success) services.mask(candidate.data.token)
  const record = parsed.success ? parsed.data : undefined
  if (
    !record ||
    record.repository !== input.repository ||
    record.repositoryId !== env.GITHUB_REPOSITORY_ID ||
    Date.parse(record.expiresAt) <= Date.now() + 60_000 ||
    Date.parse(record.expiresAt) > Date.now() + 65 * 60_000 ||
    Object.keys(record.permissions).length !== Object.keys(permissions[input.purpose]).length ||
    Object.entries(permissions[input.purpose]).some(([key, value]) => record.permissions[key] !== value)
  ) {
    if (candidate.success) await revoke(candidate.data.token, services).catch(() => undefined)
    throw new Error("The Vector GitHub App returned an invalid repository-scoped credential.")
  }
  const state: { disposal?: Promise<void> } = {}
  const auth: GithubAuth = {
    source: "app",
    token: record.token,
    repository: record.repository,
    botLogin: record.bot.login,
    botId: record.bot.id,
    expiresAt: record.expiresAt,
    dispose: () => (state.disposal ??= revoke(record.token, services)),
  }
  if (input.signal?.aborted) {
    await auth.dispose()
    input.signal.throwIfAborted()
  }
  return auth
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("The Vector GitHub App returned an empty response.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 16_384) throw new Error("oversized response")
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new Error("The Vector GitHub App returned an unreadable response.")
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function revoke(token: string, services: Services) {
  const response = await services
    .request("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => undefined)
  await response?.body?.cancel().catch(() => undefined)
  if (response?.status !== 204 && response?.status !== 401)
    throw new Error("The Vector GitHub App token could not be revoked. It expires automatically within one hour.")
}
