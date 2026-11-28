import { execFile } from "node:child_process"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"

// GitHub's REST and GraphQL APIs, called with the user's own GitHub sign-in. The Pull Requests panel, Vectorscope
// and the CI view use these instead of the GitHub CLI, so nothing has to be installed. This module stays free of
// Electron so it can be tested on its own; where the token comes from lives in github-access.ts.

export type GithubAccess = {
  token: string
  // "vector" is Vector's own GitHub sign-in; "gh" is the GitHub CLI's login, reused for someone who never signed
  // in to Vector but already uses the CLI.
  source: "vector" | "gh"
  // Tests point this at a local server; the app always talks to api.github.com.
  apiUrl?: string
}

export type GithubRepoRef = { owner: string; name: string }

export class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const API_URL = "https://api.github.com"
const NETWORK_ERROR = "Couldn't reach GitHub. Check your internet connection and try again."

export async function githubFetch(
  access: GithubAccess,
  path: string,
  init: { method?: string; body?: unknown; accept?: string; timeoutMs?: number } = {},
) {
  const response = await Egress.fetch("github", `${access.apiUrl ?? API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${access.token}`,
      accept: init.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Vector",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  }).catch((error: unknown) => {
    if (error instanceof EgressGuard.EgressBlocked) throw new GithubRequestError(error.message, 0)
    if (error instanceof Error && error.name === "TimeoutError")
      throw new GithubRequestError("GitHub took too long to answer. Try again.", 0)
    throw new GithubRequestError(NETWORK_ERROR, 0)
  })
  if (!response.ok) throw new GithubRequestError(await githubErrorMessage(response), response.status)
  return response
}

export async function githubJson<T>(access: GithubAccess, path: string, init?: Parameters<typeof githubFetch>[2]) {
  return (await (await githubFetch(access, path, init)).json()) as T
}

export async function githubGraphql<T>(access: GithubAccess, query: string, variables: Record<string, unknown>) {
  const result = await githubJson<{ data?: T; errors?: { message?: string }[] }>(access, "/graphql", {
    method: "POST",
    body: { query, variables },
    timeoutMs: 45_000,
  })
  const errors = (result.errors ?? []).map((error) => error.message).filter(Boolean)
  if (errors.length || !result.data) throw new GithubRequestError(errors.join("; ") || "GitHub returned no data.", 200)
  return result.data
}

// What the user can do about a failed call, in GitHub's own words where it gives any.
export async function githubErrorMessage(response: Response) {
  const body = (await response.json().catch(() => undefined)) as
    | { message?: string; errors?: { message?: string }[] }
    | undefined
  if (response.status === 401) return "Your GitHub sign-in has expired or was revoked. Sign in to GitHub again."
  const sso = response.headers.get("x-github-sso")
  if (response.status === 403 && sso) {
    const url = sso.match(/url=(\S+)/)?.[1]
    return url
      ? `This organization uses single sign-on. Authorize Vector for it at ${url}, then try again.`
      : "This organization uses single sign-on. Authorize Vector for it on GitHub, then try again."
  }
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"))
    const until = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toLocaleTimeString()}` : ""
    return `GitHub's API limit for this account is used up${until}. Try again then.`
  }
  if (response.status === 404) {
    return "GitHub couldn't find that, or this GitHub account can't see it. For a private repository, sign in with an account that has access."
  }
  const details = (body?.errors ?? []).map((error) => error.message).filter(Boolean)
  return [body?.message, ...details].filter(Boolean).join(": ") || `GitHub returned HTTP ${response.status}.`
}

// https, ssh (scp-style or ssh://) and git:// remotes, with or without .git, credentials or a port.
export function parseGithubRemote(raw: string): GithubRepoRef | undefined {
  const url = raw.trim()
  const match =
    url.match(/^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (!match) return
  return { owner: match[1], name: match[2] }
}

// The repository pull requests live in. A fork's clone usually names the original "upstream" and the fork
// "origin", and pull requests belong to the original, so "upstream" wins, as it does for the GitHub CLI.
export function pickBaseRemote(remotes: { name: string; url: string }[]) {
  const github = remotes.flatMap((remote) => {
    const repo = parseGithubRemote(remote.url)
    return repo ? [{ ...remote, repo }] : []
  })
  const rank = (name: string) => ["upstream", "github", "origin"].indexOf(name)
  return github.toSorted((a, b) => {
    const left = rank(a.name)
    const right = rank(b.name)
    return (left < 0 ? 99 : left) - (right < 0 ? 99 : right)
  })[0]
}

export async function gitRemotes(cwd: string) {
  const result = await git(["config", "--get-regexp", "^remote\\..*\\.url$"], cwd)
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^remote\.(.+)\.url\s+(\S+)$/)
    return match ? [{ name: match[1], url: match[2] }] : []
  })
}

export async function git(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; failed: boolean }>((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: untrustedChildEnvironment(), timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) }),
    )
  })
}

// Keeps only the last maxBytes of a body that can run to hundreds of megabytes (an Actions job log), without ever
// holding the whole thing.
export async function readTail(response: Response, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return { text: "", truncated: false }
  const chunks: Uint8Array[] = []
  let kept = 0
  let truncated = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
    kept += next.value.byteLength
    while (kept - chunks[0].byteLength >= maxBytes) {
      kept -= chunks.shift()!.byteLength
      truncated = true
    }
  }
  const bytes = Buffer.concat(chunks)
  const start = Math.max(0, bytes.byteLength - maxBytes)
  return { text: bytes.subarray(start).toString("utf8"), truncated: truncated || start > 0 }
}
