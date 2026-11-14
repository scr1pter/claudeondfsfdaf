/** @jsxImportSource react */
import React from "react"
import { readAccountApiResponse } from "../../../lib/account-client"
import "./github-agents.css"

export type GithubBinding = {
  repositoryId: string
  repository?: string
  binder?: { login: string }
  boundAt: number
  lastUsedAt?: number
  workflowVersion: string
  codium: "ready" | "unavailable"
  suspended?: "transferred" | "deleted" | "binder-left"
}
type Gate = { enabled?: boolean; listed?: readonly string[] }
type BindCode = { code: string; expiresAt: number; repository?: string }
export type GithubAgentsPreview = { config: Gate; bindings: readonly GithubBinding[]; code?: BindCode }
type Request = (url: string, init?: RequestInit) => Promise<Response>
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const DECIMAL = /^[1-9]\d{0,15}$/
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const repository = (value: string) => REPOSITORY.test(value) && ![".", ".."].includes(value.split("/")[1]!)

export function githubAgentsVisible(config: Gate | undefined, search = "") {
  return new URLSearchParams(search).get("github-preview") === "1" ||
    Boolean(config?.enabled === true && Array.isArray(config.listed) && config.listed.includes("github-agents"))
}

/** Even an older or malformed server response cannot disclose names on an access-lost connection. */
export function readGithubBindings(value: unknown): GithubBinding[] {
  if (!record(value) || !Array.isArray(value.bindings) || value.bindings.length > 200) throw new GithubConnectionError(503)
  const seen = new Set<string>()
  return value.bindings.map((item) => {
    if (!record(item) || typeof item.repositoryId !== "string" || !DECIMAL.test(item.repositoryId) ||
      !Number.isSafeInteger(Number(item.repositoryId)) || seen.has(item.repositoryId) || !time(item.boundAt) ||
      (item.lastUsedAt !== undefined && !time(item.lastUsedAt)) || typeof item.workflowVersion !== "string" ||
      !/^\d{1,6}$/.test(item.workflowVersion) || typeof item.codium !== "string" || !["ready", "unavailable"].includes(item.codium) ||
      (item.suspended !== undefined && (typeof item.suspended !== "string" || !["transferred", "deleted", "binder-left"].includes(item.suspended)))) throw new GithubConnectionError(503)
    seen.add(item.repositoryId)
    const hidden = item.suspended === "binder-left"
    if (!hidden && ((item.repository !== undefined && (typeof item.repository !== "string" || !repository(item.repository))) ||
      (item.binder !== undefined && (!record(item.binder) || typeof item.binder.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(item.binder.login))))) throw new GithubConnectionError(503)
    return { repositoryId: item.repositoryId, boundAt: item.boundAt, workflowVersion: item.workflowVersion,
      codium: item.suspended ? "unavailable" : item.codium as GithubBinding["codium"],
      ...(time(item.lastUsedAt) ? { lastUsedAt: item.lastUsedAt } : {}),
      ...(item.suspended ? { suspended: item.suspended as GithubBinding["suspended"] } : {}),
      ...(!hidden && typeof item.repository === "string" ? { repository: item.repository } : {}),
      ...(!hidden && record(item.binder) && typeof item.binder.login === "string" ? { binder: { login: item.binder.login } } : {}),
    }
  })
}

export class GithubConnectionError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? "Sign in again to manage your GitHub repositories."
      : status === 403 ? "This account cannot change that repository connection."
      : status === 400 ? "Check the repository name and try again."
      : status === 409 ? "This connection changed. Refresh and try again."
      : status === 429 ? "Too many requests. Wait a moment and try again."
      : "Repository connections are unavailable. Try again.")
  }
}
async function accountRequest(path: string, accessToken: string, method: "GET" | "POST", body: unknown,
  request: Request, signal?: AbortSignal) {
  if (!accessToken) throw new GithubConnectionError(401)
  let response: Response
  try {
    response = await request(path, { method, headers: { accept: "application/json", authorization: `Bearer ${accessToken}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
  } catch { throw new GithubConnectionError(503) }
  try { return await readAccountApiResponse(response, "Repository connections are unavailable. Try again.") }
  catch { throw new GithubConnectionError(response.ok ? 503 : response.status) }
}
export async function requestGithubBindCode(accessToken: string, name: string, request: Request = fetch, signal?: AbortSignal) {
  const selected = name.trim()
  if (!repository(selected)) throw new GithubConnectionError(400)
  const value = await accountRequest("/api/cloud-agents/bind-code", accessToken, "POST", { repository: selected }, request, signal)
  if (typeof value.code !== "string" || !/^vbc_[A-Za-z0-9_-]{43}$/.test(value.code) || !time(value.expiresAt) ||
    value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 24 * 60 * 60_000) throw new GithubConnectionError(503)
  return { code: value.code, expiresAt: value.expiresAt, repository: selected }
}
export async function requestGithubUnbind(accessToken: string, repositoryId: string, request: Request = fetch, signal?: AbortSignal) {
  if (!DECIMAL.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId))) throw new GithubConnectionError(400)
  const value = await accountRequest("/api/cloud-agents/unbind", accessToken, "POST", { repositoryId }, request, signal)
  if (value.ok !== true) throw new GithubConnectionError(503)
}
const when = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

/** Public listing controls visibility only. The account endpoints independently authorize every operation. */
export function GithubAgents(props: { accessToken: string; preview?: GithubAgentsPreview; search?: string }) {
  const [config, setConfig] = React.useState<Gate | undefined>(props.preview?.config)
  const [bindings, setBindings] = React.useState<readonly GithubBinding[]>(props.preview?.bindings ?? [])
  const [search, setSearch] = React.useState(props.search ?? "")
  const [name, setName] = React.useState(props.preview?.code?.repository ?? "")
  const [code, setCode] = React.useState<BindCode | undefined>(props.preview?.code)
  const [copied, setCopied] = React.useState(false)
  const [loading, setLoading] = React.useState(Boolean(props.accessToken) && !props.preview)
  const [action, setAction] = React.useState("")
  const [error, setError] = React.useState<GithubConnectionError>()
  const [notice, setNotice] = React.useState("")
  const [refresh, setRefresh] = React.useState(0)
  const [loadedFor, setLoadedFor] = React.useState(props.preview ? props.accessToken : "")
  const generation = React.useRef(0)
  const pending = React.useRef(false)
  const actionRequest = React.useRef<AbortController | undefined>(undefined)
  const visible = githubAgentsVisible(config, search)
  const currentAccount = Boolean(props.preview) || loadedFor === props.accessToken

  React.useEffect(() => {
    setSearch(props.search ?? location.search)
    const leave = () => { setCode(undefined); setCopied(false); actionRequest.current?.abort() }
    const navigate = () => { leave(); setSearch(props.search ?? location.search) }
    window.addEventListener("pagehide", leave)
    window.addEventListener("popstate", navigate)
    window.addEventListener("hashchange", navigate)
    return () => { leave(); window.removeEventListener("pagehide", leave); window.removeEventListener("popstate", navigate); window.removeEventListener("hashchange", navigate) }
  }, [props.search])
  React.useEffect(() => {
    if (!code) return
    const timer = window.setTimeout(() => { setCode(undefined); setCopied(false) }, Math.max(0, Math.min(code.expiresAt - Date.now(), 24 * 60 * 60_000)))
    return () => window.clearTimeout(timer)
  }, [code])
  React.useEffect(() => {
    if (props.preview) return
    const current = ++generation.current
    const controller = new AbortController()
    actionRequest.current?.abort()
    pending.current = false
    if (loadedFor !== props.accessToken) setName("")
    setLoadedFor(props.accessToken)
    setCode(undefined); setCopied(false); setBindings([]); setAction(""); setError(undefined); setNotice("")
    if (!props.accessToken) { setLoading(false); return () => controller.abort() }
    setLoading(true)
    let publicReady = false
    void fetch("/api/model-plans/config", { headers: { accept: "application/json" }, cache: "no-store", redirect: "error", signal: controller.signal })
      .then(async (response) => {
        const value: unknown = response.ok ? await response.json() : undefined
        if (!record(value) || typeof value.enabled !== "boolean") throw new GithubConnectionError(503)
        const next = { enabled: value.enabled, listed: Array.isArray(value.listed) ? value.listed.filter((item): item is string => typeof item === "string") : [] }
        if (controller.signal.aborted || current !== generation.current) return
        publicReady = true
        setConfig(next)
        if (!githubAgentsVisible(next, search)) return
        const body = await accountRequest("/api/cloud-agents/bindings", props.accessToken, "GET", undefined, fetch, controller.signal)
        if (!controller.signal.aborted && current === generation.current) setBindings(readGithubBindings(body))
      })
      .catch((cause) => {
        if (!controller.signal.aborted && current === generation.current) {
          if (!publicReady) setConfig(undefined)
          setError(cause instanceof GithubConnectionError ? cause : new GithubConnectionError(503))
        }
      })
      .finally(() => { if (!controller.signal.aborted && current === generation.current) setLoading(false) })
    return () => { controller.abort(); actionRequest.current?.abort(); generation.current++ }
  }, [props.accessToken, props.preview, refresh, search])

  const perform = async (id: string, run: (signal: AbortSignal) => Promise<void>) => {
    if (props.preview || !props.accessToken || !currentAccount || pending.current || !visible) return
    const current = generation.current
    const controller = new AbortController()
    actionRequest.current = controller
    pending.current = true
    setAction(id); setError(undefined); setNotice("")
    try { await run(controller.signal) }
    catch (cause) { if (!controller.signal.aborted && current === generation.current) setError(cause instanceof GithubConnectionError ? cause : new GithubConnectionError(503)) }
    finally { if (current === generation.current) { pending.current = false; setAction("") } }
  }
  const issue = () => {
    const selected = name.trim()
    const current = generation.current
    setCode(undefined); setCopied(false)
    void perform("code", async (signal) => {
      const prepared = await requestGithubBindCode(props.accessToken, selected, fetch, signal)
      if (!signal.aborted && current === generation.current) setCode(prepared)
    })
  }
  const unbind = (binding: GithubBinding) => {
    const current = generation.current
    void perform(binding.repositoryId, async (signal) => {
      await requestGithubUnbind(props.accessToken, binding.repositoryId, fetch, signal)
      if (!signal.aborted && current === generation.current) {
        setBindings((rows) => rows.filter((row) => row.repositoryId !== binding.repositoryId))
        setNotice("Repository disconnected.")
      }
    })
  }
  const copy = async () => {
    if (!code || code.expiresAt <= Date.now()) return
    const current = generation.current
    try { await navigator.clipboard.writeText(code.code); if (current === generation.current) setCopied(true) }
    catch { if (current === generation.current) setNotice("Copy the bind code manually from this page.") }
  }
  if (!visible) return null
  const activeCode = currentAccount && code && code.expiresAt > Date.now() ? code : undefined
  const currentBindings = currentAccount ? bindings : []
  const disabled = loading || Boolean(action) || !props.accessToken || !currentAccount || Boolean(props.preview) || error?.status === 401
  return <section id="github" className="acct-section github-agents" aria-labelledby="github-agents-heading" aria-busy={loading || Boolean(action)}>
    <h2 id="github-agents-heading">GitHub agents</h2>
    <p>Run /vector in your own repo, on your own Actions minutes.</p>
    <p>Connect a repository's Vector workflow to Codium. Anyone with write access to that repository can start runs using this connection.</p>
    <a href="/docs/vectorscope">Set up the repository workflow</a>
    {!props.accessToken && !props.preview && <p><a href="/login?returnTo=%2Faccount%23github">Sign in to manage your GitHub repositories</a></p>}
    {error && <p role="alert" className="account-error">{error.message}{error.status === 401 && <React.Fragment> <a href="/login?returnTo=%2Faccount%23github">Sign in again</a></React.Fragment>}</p>}
    {notice && <p role="status">{notice}</p>}
    <form className="github-agents-form" onSubmit={(event) => { event.preventDefault(); issue() }}>
      <label htmlFor="github-agent-repository">Repository</label>
      <div className="github-agents-form-row">
        <input id="github-agent-repository" name="repository" value={currentAccount ? name : ""} required maxLength={140} autoComplete="off" autoCapitalize="none" spellCheck={false}
          placeholder="owner/repository" disabled={disabled || Boolean(activeCode)} onChange={(event) => setName(event.target.value)} aria-describedby="github-agent-code-help" />
        <button type="submit" className="acct-button" disabled={disabled || loading || Boolean(activeCode) || !repository(name.trim())}>{action === "code" ? "Preparing…" : "Get bind code"}</button>
      </div>
      <p id="github-agent-code-help" className="acct-fine">A code is shown once for this repository and expires after ten minutes. Keep it on this page until you use it.</p>
    </form>
    {activeCode && <div className="github-agents-code" aria-label="Repository bind code">
      {activeCode.repository && <p>For <strong>{activeCode.repository}</strong></p>}
      <div className="acct-code-row"><code aria-label="One-time bind code">{activeCode.code}</code><button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy code"}</button></div>
      <p className="acct-fine">Expires {when(activeCode.expiresAt)}. Leaving this page clears the code.</p>
      <ol className="acct-steps">
        <li><span>Open your repository's Actions tab and select the Vector workflow on its default branch.</span></li>
        <li><span>Choose Run workflow, set <code>mode</code> to <code>bind</code>, and paste this value into <code>code</code>.</span></li>
        <li><span>After the run finishes, choose Refresh here to see the connection.</span></li>
      </ol>
      <button type="button" className="acct-button acct-button-secondary" onClick={() => { setCode(undefined); setCopied(false) }}>Hide code</button>
    </div>}
    <div className="github-agents-list-heading"><h3>Connected repositories</h3><button type="button" className="acct-button acct-button-secondary" disabled={loading || disabled} onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
    {loading ? <p role="status">Loading repository connections…</p> : <React.Fragment>
      {!currentBindings.length && !error && <p>No connected repositories yet.</p>}
      <ul className="github-agents-list" aria-label="Connected repositories">
        {currentBindings.map((binding) => <li key={binding.repositoryId}>
          <strong>{binding.suspended === "binder-left" ? "Repository access changed" : binding.repository ?? "Repository connection"}</strong>
          <p className="acct-fine">{binding.codium === "ready" && !binding.suspended ? "Codium ready" : "Codium unavailable"} · Workflow v{binding.workflowVersion}</p>
          <p className="acct-fine">Connected {when(binding.boundAt)} · {binding.lastUsedAt ? `Last used ${when(binding.lastUsedAt)}` : "Not used yet"}</p>
          {binding.suspended !== "binder-left" && binding.binder && <p className="acct-fine">Connected by {binding.binder.login}</p>}
          {binding.suspended && <p className="acct-fine">{binding.suspended === "binder-left" ? "Restore repository access before connecting again." : "This connection needs attention. Connect the repository again to continue."}</p>}
          <button type="button" className="acct-button acct-button-secondary" disabled={disabled} onClick={() => unbind(binding)} aria-label={`Unbind ${binding.suspended === "binder-left" ? "repository connection" : binding.repository ?? "repository connection"}`}>
            {action === binding.repositoryId ? "Disconnecting…" : "Unbind"}
          </button>
        </li>)}
      </ul>
    </React.Fragment>}
  </section>
}
