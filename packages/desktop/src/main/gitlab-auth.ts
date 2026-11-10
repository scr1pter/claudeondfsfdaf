import { shell } from "electron"

import { getStore, removeStoreFileIfEmpty } from "./store"
import { vaultSecrets } from "./vault-secrets"

// GitLab OAuth Device Flow: sign in to GitLab from Vector without the glab CLI.
// Mirrors github-auth.ts. Device flow needs ONLY a public OAuth application ID —
// never a client secret — so it is safe to ship inside a desktop binary. The
// resulting token is sealed with Vector's credential vault (protected by
// Keychain / DPAPI / libsecret) before it touches disk, and it is never logged.

// The client ID is a public OAuth application ID (device flow requires no secret),
// so it is safe to ship inside the desktop binary. Override it at build/run time
// via the VECTOR_GITLAB_CLIENT_ID env var for self-managed GitLab instances.
const DEFAULT_GITLAB_CLIENT_ID = "8ac2300994dbece9bfc889ee6705f4ab8a8243b9acd04fe6185172528abc8edd"
const GITLAB_CLIENT_ID = (process.env.VECTOR_GITLAB_CLIENT_ID?.trim() ?? "") || DEFAULT_GITLAB_CLIENT_ID

// Self-managed GitLab instances swap this host; kept as a constant so it is easy
// to make configurable later.
const GITLAB_HOST = (process.env.VECTOR_GITLAB_HOST?.trim() ?? "") || "https://gitlab.com"
const GITLAB_API = `${GITLAB_HOST}/api/v4`
// Only `api` can create projects; it also grants repository write for HTTPS push.
const GITLAB_SCOPE = "api"

const AUTH_STORE = "gitlab-auth"
const TOKEN_KEY = "token"
const TOKEN_PURPOSE = "gitlab-token"
const LOGIN_KEY = "login"
const AVATAR_KEY = "avatarUrl"

const SECURE_STORAGE_ERROR = "Vector can't store the GitLab token securely on this system."
const NETWORK_ERROR = "Couldn't reach GitLab. Check your internet connection and try again."

export type GitlabAuthStatus = {
  configured: boolean
  authenticated: boolean
  login?: string
  avatarUrl?: string
}

export type GitlabDeviceLoginStart = {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export type GitlabDeviceLoginResult = { ok: boolean; login?: string; error?: string }

export type GitlabRepo = {
  id: number
  name: string
  pathWithNamespace: string
  private: boolean
  lastActivityAt?: string
  defaultBranch?: string
  webUrl: string
  // http_url_to_repo — pushed to directly so nested groups/subgroups resolve.
  httpUrl: string
}

export type GitlabCreateRepoInput = { name: string; private: boolean; description?: string }

// ---- Device flow ----------------------------------------------------------

type DeviceFlow = {
  deviceCode: string
  verificationUri: string
  intervalMs: number
  expiresAt: number
  cancelled: boolean
  wake?: () => void
}

let activeFlow: DeviceFlow | null = null

function apiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  }
}

export async function startDeviceLogin(): Promise<GitlabDeviceLoginStart> {
  if (!GITLAB_CLIENT_ID) {
    throw new Error("GitLab sign-in isn't configured in this build of Vector.")
  }
  // Fail before the user does the whole verification dance, not after.
  if (!vaultSecrets.available()) throw new Error(SECURE_STORAGE_ERROR)
  // Restarting sign-in drops any stale flow so an old poll loop can't race us.
  cancelDeviceLogin()

  const res = await fetch(`${GITLAB_HOST}/oauth/authorize_device`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GITLAB_CLIENT_ID, scope: GITLAB_SCOPE }).toString(),
  }).catch(() => undefined)
  if (!res) throw new Error(NETWORK_ERROR)
  const data = (await res.json().catch(() => undefined)) as
    | {
        device_code?: string
        user_code?: string
        verification_uri?: string
        verification_uri_complete?: string
        expires_in?: number
        interval?: number
        error?: string
        error_description?: string
      }
    | undefined
  if (!res.ok || !data?.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(
      data?.error_description || data?.error || `GitLab rejected the sign-in request (HTTP ${res.status}).`,
    )
  }

  const expiresIn = data.expires_in ?? 900
  activeFlow = {
    deviceCode: data.device_code,
    verificationUri: data.verification_uri,
    intervalMs: Math.max(1, data.interval ?? 5) * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
    cancelled: false,
  }
  return { userCode: data.user_code, verificationUri: data.verification_uri, expiresIn }
}

// The renderer decides WHEN to open the browser (it has a button); we only
// perform the shell call so the renderer never handles raw shell access.
export async function openVerification(): Promise<void> {
  await shell.openExternal(activeFlow?.verificationUri ?? `${GITLAB_HOST}/oauth/device`)
}

export function cancelDeviceLogin(): void {
  const flow = activeFlow
  if (!flow) return
  flow.cancelled = true
  flow.wake?.()
  activeFlow = null
}

// Interruptible wait: cancelDeviceLogin() wakes the loop immediately instead
// of leaving a dangling multi-second timer behind.
function pollDelay(flow: DeviceFlow): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flow.wake = undefined
      resolve()
    }, flow.intervalMs)
    flow.wake = () => {
      clearTimeout(timer)
      flow.wake = undefined
      resolve()
    }
  })
}

export async function completeDeviceLogin(): Promise<GitlabDeviceLoginResult> {
  const flow = activeFlow
  if (!flow) return { ok: false, error: "No GitLab sign-in is in progress. Start again." }
  try {
    while (true) {
      if (flow.cancelled) return { ok: false, error: "GitLab sign-in was cancelled." }
      if (Date.now() >= flow.expiresAt) return { ok: false, error: "The sign-in code expired. Start again." }
      await pollDelay(flow)
      if (flow.cancelled) return { ok: false, error: "GitLab sign-in was cancelled." }

      const res = await fetch(`${GITLAB_HOST}/oauth/token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GITLAB_CLIENT_ID,
          device_code: flow.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      }).catch(() => undefined)
      if (!res) return { ok: false, error: NETWORK_ERROR }
      const data = (await res.json().catch(() => undefined)) as
        | { access_token?: string; error?: string; error_description?: string }
        | undefined

      if (data?.access_token) return finishLogin(data.access_token)
      switch (data?.error) {
        case "authorization_pending":
          continue
        case "slow_down":
          flow.intervalMs += 5000
          continue
        case "expired_token":
          return { ok: false, error: "The sign-in code expired. Start again." }
        case "access_denied":
          return { ok: false, error: "GitLab sign-in was declined." }
        default:
          return { ok: false, error: data?.error_description || data?.error || "GitLab sign-in failed. Try again." }
      }
    }
  } finally {
    if (activeFlow === flow) activeFlow = null
  }
}

async function finishLogin(token: string): Promise<GitlabDeviceLoginResult> {
  const res = await fetch(`${GITLAB_API}/user`, { headers: apiHeaders(token) }).catch(() => undefined)
  if (!res?.ok) return { ok: false, error: "Signed in, but couldn't load your GitLab profile. Try again." }
  const user = (await res.json().catch(() => undefined)) as { username?: string; avatar_url?: string } | undefined
  if (!vaultSecrets.available()) return { ok: false, error: SECURE_STORAGE_ERROR }

  const store = getStore(AUTH_STORE)
  store.set(TOKEN_KEY, vaultSecrets.seal(token, TOKEN_PURPOSE))
  if (user?.username) store.set(LOGIN_KEY, user.username)
  if (user?.avatar_url) store.set(AVATAR_KEY, user.avatar_url)
  return { ok: true, login: user?.username }
}

// ---- Token storage --------------------------------------------------------

export function getGitlabToken(): string | undefined {
  const store = getStore(AUTH_STORE)
  const raw = store.get(TOKEN_KEY)
  if (typeof raw !== "string" || !raw) return
  if (!vaultSecrets.available()) return
  try {
    const opened = vaultSecrets.openSync(raw, TOKEN_PURPOSE)
    // An earlier release's token moves into the vault.
    if (opened.resealed) store.set(TOKEN_KEY, opened.resealed)
    return opened.text
  } catch {
    // The vault key changed (or the blob is corrupt) — the token is unrecoverable.
    logoutGitlab()
    return
  }
}

export function logoutGitlab(): void {
  cancelDeviceLogin()
  const store = getStore(AUTH_STORE)
  store.delete(TOKEN_KEY)
  store.delete(LOGIN_KEY)
  store.delete(AVATAR_KEY)
  void removeStoreFileIfEmpty(AUTH_STORE)
}

function cachedProfile(): { login?: string; avatarUrl?: string } {
  const store = getStore(AUTH_STORE)
  const login = store.get(LOGIN_KEY)
  const avatarUrl = store.get(AVATAR_KEY)
  return {
    login: typeof login === "string" && login ? login : undefined,
    avatarUrl: typeof avatarUrl === "string" && avatarUrl ? avatarUrl : undefined,
  }
}

export async function getAuthStatus(): Promise<GitlabAuthStatus> {
  const configured = Boolean(GITLAB_CLIENT_ID)
  const token = getGitlabToken()
  if (!token) return { configured, authenticated: false }

  try {
    const res = await fetch(`${GITLAB_API}/user`, { headers: apiHeaders(token) })
    if (res.status === 401) {
      // The user revoked the token on gitlab.com — treat as signed out.
      logoutGitlab()
      return { configured, authenticated: false }
    }
    if (res.ok) {
      const user = (await res.json().catch(() => undefined)) as { username?: string; avatar_url?: string } | undefined
      const store = getStore(AUTH_STORE)
      if (user?.username) store.set(LOGIN_KEY, user.username)
      if (user?.avatar_url) store.set(AVATAR_KEY, user.avatar_url)
      return { configured, authenticated: true, login: user?.username, avatarUrl: user?.avatar_url }
    }
  } catch {
    // Offline — fall through to the cached identity below.
  }
  // Rate-limited or offline: we still hold a token, so stay "signed in" with
  // whatever identity we last saw.
  return { configured, authenticated: true, ...cachedProfile() }
}

// ---- Projects (repositories) ----------------------------------------------

type RawProject = {
  id?: number
  name?: string
  path_with_namespace?: string
  visibility?: string
  last_activity_at?: string | null
  default_branch?: string | null
  web_url?: string
  http_url_to_repo?: string
}

// Exported for unit tests.
export function mapGitlabRepo(raw: RawProject): GitlabRepo {
  const pathWithNamespace = raw.path_with_namespace ?? ""
  const webUrl = raw.web_url ?? (pathWithNamespace ? `${GITLAB_HOST}/${pathWithNamespace}` : "")
  return {
    id: raw.id ?? 0,
    name: raw.name ?? pathWithNamespace.split("/").at(-1) ?? "",
    pathWithNamespace,
    private: raw.visibility ? raw.visibility !== "public" : true,
    lastActivityAt: raw.last_activity_at ?? undefined,
    defaultBranch: raw.default_branch ?? undefined,
    webUrl,
    httpUrl: raw.http_url_to_repo ?? (pathWithNamespace ? `${GITLAB_HOST}/${pathWithNamespace}.git` : ""),
  }
}

function requireToken(): string {
  const token = getGitlabToken()
  if (!token) throw new Error("Sign in to GitLab first.")
  return token
}

export async function listRepos(): Promise<GitlabRepo[]> {
  const token = requireToken()
  // min_access_level=30 (Developer) keeps the list to projects the user can push to.
  const res = await fetch(
    `${GITLAB_API}/projects?membership=true&min_access_level=30&order_by=last_activity_at&per_page=100`,
    { headers: apiHeaders(token) },
  ).catch(() => undefined)
  if (!res) throw new Error(NETWORK_ERROR)
  if (res.status === 401) {
    logoutGitlab()
    throw new Error("Your GitLab session expired. Sign in again.")
  }
  if (!res.ok) throw new Error(`GitLab returned HTTP ${res.status} while listing GitLab projects.`)
  const raw = (await res.json().catch(() => undefined)) as RawProject[] | undefined
  return (Array.isArray(raw) ? raw : []).map(mapGitlabRepo)
}

export async function createRepo(input: GitlabCreateRepoInput): Promise<GitlabRepo> {
  const token = requireToken()
  const res = await fetch(`${GITLAB_API}/projects`, {
    method: "POST",
    headers: { ...apiHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      visibility: input.private ? "private" : "public",
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    }),
  }).catch(() => undefined)
  if (!res) throw new Error(NETWORK_ERROR)
  if (res.status === 401) {
    logoutGitlab()
    throw new Error("Your GitLab session expired. Sign in again.")
  }
  const body = (await res.json().catch(() => undefined)) as
    | (RawProject & { message?: unknown; error?: string })
    | undefined
  if (!res.ok) {
    // Surface GitLab's own validation detail ("has already been taken") when
    // present — it is friendlier than our generic message.
    const detail = extractGitlabError(body?.message) || (typeof body?.error === "string" ? body.error : "")
    throw new Error(detail || `GitLab returned HTTP ${res.status} while creating the GitLab project.`)
  }
  if (!body?.name) throw new Error("GitLab created the new GitLab project but returned an unexpected response.")
  return mapGitlabRepo(body)
}

// GitLab validation errors arrive as either a string or a
// { field: [messages] } map — flatten whichever shape we get.
function extractGitlabError(message: unknown): string {
  if (!message) return ""
  if (typeof message === "string") return message
  if (Array.isArray(message)) return message.filter((item) => typeof item === "string").join(" ")
  if (typeof message === "object") {
    return Object.entries(message as Record<string, unknown>)
      .map(([field, value]) => {
        const text = Array.isArray(value) ? value.join(", ") : String(value)
        return `${field} ${text}`
      })
      .join("; ")
  }
  return ""
}
