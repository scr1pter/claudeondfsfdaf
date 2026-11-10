import { shell } from "electron"

import { getStore, removeStoreFileIfEmpty } from "./store"
import { vaultSecrets } from "./vault-secrets"

// GitHub OAuth Device Flow: sign in to GitHub from Vector without the gh CLI.
// Device flow needs ONLY a public OAuth client ID — never a client secret — so
// it is safe to ship inside a desktop binary. The resulting token is sealed
// with Vector's credential vault (protected by Keychain / DPAPI / libsecret)
// before it touches disk, and it is never logged.

// Paste your GitHub OAuth App client ID here (Settings → Developer settings →
// OAuth Apps, with "Enable Device Flow" checked) to bake it into the build.
const DEFAULT_GITHUB_CLIENT_ID = "Ov23lim8aKAF62cWa6yD"
const GITHUB_CLIENT_ID = (process.env.VECTOR_GITHUB_CLIENT_ID?.trim() ?? "") || DEFAULT_GITHUB_CLIENT_ID

const AUTH_STORE = "github-auth"
const TOKEN_KEY = "token"
const TOKEN_PURPOSE = "github-token"
const LOGIN_KEY = "login"
const AVATAR_KEY = "avatarUrl"

const SECURE_STORAGE_ERROR = "Vector can't store the GitHub token securely on this system."
const NETWORK_ERROR = "Couldn't reach GitHub. Check your internet connection and try again."

export type GithubAuthStatus = {
  configured: boolean
  authenticated: boolean
  login?: string
  avatarUrl?: string
}

export type GithubDeviceLoginStart = {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export type GithubDeviceLoginResult = { ok: boolean; login?: string; error?: string }

export type GithubRepo = {
  owner: string
  name: string
  fullName: string
  private: boolean
  pushedAt?: string
  defaultBranch?: string
  htmlUrl: string
  canPush: boolean
}

export type GithubCreateRepoInput = { name: string; private: boolean; description?: string }

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

export function apiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  }
}

// Pull requests and reviews need repo. workflow lets a token change workflow files in every repository the account can
// push to, so it is asked for only when someone sets up Vectorscope's automatic reviews.
export function deviceLoginScope(input?: { workflow?: boolean }) {
  return input?.workflow === true ? "repo workflow" : "repo"
}

export async function startDeviceLogin(input?: { workflow?: boolean }): Promise<GithubDeviceLoginStart> {
  if (!GITHUB_CLIENT_ID) {
    throw new Error("GitHub sign-in isn't configured in this build of Vector.")
  }
  // Fail before the user does the whole verification dance, not after.
  if (!vaultSecrets.available()) throw new Error(SECURE_STORAGE_ERROR)
  // Restarting sign-in drops any stale flow so an old poll loop can't race us.
  cancelDeviceLogin()

  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: deviceLoginScope(input) }),
  }).catch(() => undefined)
  if (!res) throw new Error(NETWORK_ERROR)
  const data = (await res.json().catch(() => undefined)) as
    | {
        device_code?: string
        user_code?: string
        verification_uri?: string
        expires_in?: number
        interval?: number
        error?: string
        error_description?: string
      }
    | undefined
  if (!res.ok || !data?.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(
      data?.error_description || data?.error || `GitHub rejected the sign-in request (HTTP ${res.status}).`,
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
  await shell.openExternal(activeFlow?.verificationUri ?? "https://github.com/login/device")
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

export async function completeDeviceLogin(): Promise<GithubDeviceLoginResult> {
  const flow = activeFlow
  if (!flow) return { ok: false, error: "No GitHub sign-in is in progress. Start again." }
  try {
    while (true) {
      if (flow.cancelled) return { ok: false, error: "GitHub sign-in was cancelled." }
      if (Date.now() >= flow.expiresAt) return { ok: false, error: "The sign-in code expired. Start again." }
      await pollDelay(flow)
      if (flow.cancelled) return { ok: false, error: "GitHub sign-in was cancelled." }

      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: flow.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
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
          return { ok: false, error: "GitHub sign-in was declined." }
        default:
          return { ok: false, error: data?.error_description || data?.error || "GitHub sign-in failed. Try again." }
      }
    }
  } finally {
    if (activeFlow === flow) activeFlow = null
  }
}

async function finishLogin(token: string): Promise<GithubDeviceLoginResult> {
  const res = await fetch("https://api.github.com/user", { headers: apiHeaders(token) }).catch(() => undefined)
  if (!res?.ok) return { ok: false, error: "Signed in, but couldn't load your GitHub profile. Try again." }
  const user = (await res.json().catch(() => undefined)) as { login?: string; avatar_url?: string } | undefined
  if (!vaultSecrets.available()) return { ok: false, error: SECURE_STORAGE_ERROR }
  const store = getStore(AUTH_STORE)
  store.set(TOKEN_KEY, vaultSecrets.seal(token, TOKEN_PURPOSE))
  if (user?.login) store.set(LOGIN_KEY, user.login)
  if (user?.avatar_url) store.set(AVATAR_KEY, user.avatar_url)
  return { ok: true, login: user?.login }
}

// ---- Token storage --------------------------------------------------------

export async function getGithubToken(): Promise<string | undefined> {
  const store = getStore(AUTH_STORE)
  const raw = store.get(TOKEN_KEY)
  if (typeof raw !== "string" || !raw || !vaultSecrets.available()) return
  const opened = await vaultSecrets.open(raw, TOKEN_PURPOSE).catch(() => undefined)
  if (!opened) {
    // The vault key changed (or the blob is corrupt) — the token is unrecoverable.
    logoutGithub()
    return
  }
  // Unless the person signed out or in again meanwhile, an earlier release's token moves into the vault.
  if (opened.resealed && store.get(TOKEN_KEY) === raw) store.set(TOKEN_KEY, opened.resealed)
  return opened.text
}

export function logoutGithub(): void {
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

export async function getAuthStatus(): Promise<GithubAuthStatus> {
  const configured = Boolean(GITHUB_CLIENT_ID)
  const token = await getGithubToken()
  if (!token) return { configured, authenticated: false }

  try {
    const res = await fetch("https://api.github.com/user", { headers: apiHeaders(token) })
    if (res.status === 401) {
      // The user revoked the token on github.com — treat as signed out.
      logoutGithub()
      return { configured, authenticated: false }
    }
    if (res.ok) {
      const user = (await res.json().catch(() => undefined)) as { login?: string; avatar_url?: string } | undefined
      const store = getStore(AUTH_STORE)
      if (user?.login) store.set(LOGIN_KEY, user.login)
      if (user?.avatar_url) store.set(AVATAR_KEY, user.avatar_url)
      return { configured, authenticated: true, login: user?.login, avatarUrl: user?.avatar_url }
    }
  } catch {
    // Offline — fall through to the cached identity below.
  }
  // Rate-limited or offline: we still hold a token, so stay "signed in" with
  // whatever identity we last saw.
  return { configured, authenticated: true, ...cachedProfile() }
}

// ---- Repositories ---------------------------------------------------------

type RawRepo = {
  name?: string
  full_name?: string
  private?: boolean
  pushed_at?: string | null
  default_branch?: string | null
  html_url?: string
  owner?: { login?: string } | null
  permissions?: { push?: boolean } | null
}

// Exported for unit tests.
export function mapGithubRepo(raw: RawRepo): GithubRepo {
  const owner = raw.owner?.login ?? raw.full_name?.split("/")[0] ?? ""
  const name = raw.name ?? ""
  return {
    owner,
    name,
    fullName: raw.full_name ?? (owner && name ? `${owner}/${name}` : name),
    private: Boolean(raw.private),
    pushedAt: raw.pushed_at ?? undefined,
    defaultBranch: raw.default_branch ?? undefined,
    htmlUrl: raw.html_url ?? (owner && name ? `https://github.com/${owner}/${name}` : ""),
    // Organization membership lists repositories the user may only read. A response without permissions, such as a
    // repository the user just created, is their own.
    canPush: raw.permissions?.push ?? true,
  }
}

async function requireToken(): Promise<string> {
  const token = await getGithubToken()
  if (!token) throw new Error("Sign in to GitHub first.")
  return token
}

// Five pages of 100 cover nearly every account; past that, pasting the repository's link still works.
const REPO_PAGE_LIMIT = 5

export async function listRepos(): Promise<GithubRepo[]> {
  const token = await requireToken()
  const res = await fetch(
    "https://api.github.com/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member",
    { headers: apiHeaders(token) },
  ).catch(() => undefined)
  if (!res) throw new Error(NETWORK_ERROR)
  if (res.status === 401) {
    logoutGithub()
    throw new Error("Your GitHub session expired. Sign in again.")
  }
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} while listing repositories.`)
  const raw = (await res.json().catch(() => undefined)) as RawRepo[] | undefined
  const later = await laterRepoPages(token, nextPageUrl(res.headers.get("link")), REPO_PAGE_LIMIT - 1)
  // Pages can overlap when a push reorders the list mid-walk; the first (most recently pushed) copy wins.
  const repos = new Map<string, GithubRepo>()
  for (const repo of [...(Array.isArray(raw) ? raw : []), ...later].map(mapGithubRepo)) {
    if (!repos.has(repo.fullName)) repos.set(repo.fullName, repo)
  }
  return [...repos.values()]
}

// A failed later page keeps the repositories already loaded rather than failing the whole list.
async function laterRepoPages(token: string, url: string | undefined, remaining: number): Promise<RawRepo[]> {
  if (!url || remaining <= 0) return []
  const res = await fetch(url, { headers: apiHeaders(token) }).catch(() => undefined)
  if (!res?.ok) return []
  const raw = (await res.json().catch(() => undefined)) as RawRepo[] | undefined
  if (!Array.isArray(raw)) return []
  return [...raw, ...(await laterRepoPages(token, nextPageUrl(res.headers.get("link")), remaining - 1))]
}

// The rel="next" URL from GitHub's Link header. Only an api.github.com URL is followed, because the token rides along.
// Exported for unit tests.
export function nextPageUrl(link: string | null | undefined) {
  const next = link
    ?.split(",")
    .map((part) => /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())?.[1])
    .find(Boolean)
  return next?.startsWith("https://api.github.com/") ? next : undefined
}

export async function createRepo(input: GithubCreateRepoInput): Promise<GithubRepo> {
  const token = await requireToken()
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { ...apiHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      private: input.private,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    }),
  }).catch(() => undefined)
  if (!res) throw new Error(NETWORK_ERROR)
  if (res.status === 401) {
    logoutGithub()
    throw new Error("Your GitHub session expired. Sign in again.")
  }
  const body = (await res.json().catch(() => undefined)) as
    | (RawRepo & { message?: string; errors?: { field?: string; code?: string; message?: string }[] })
    | undefined
  if (!res.ok) {
    // Surface GitHub's own validation detail ("name already exists on this
    // account") when present — it is friendlier than our generic message.
    const detail = body?.errors?.map((item) => item.message).filter(Boolean).join(" ")
    throw new Error(detail || body?.message || `GitHub returned HTTP ${res.status} while creating the repository.`)
  }
  if (!body?.name) throw new Error("GitHub created the repository but returned an unexpected response.")
  return mapGithubRepo(body)
}
