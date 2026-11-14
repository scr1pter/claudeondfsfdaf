/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  ArrowUp,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react"
import vectorMark from "../../assets/vector-mark.webp"
import { vectorAccountClient } from "../../lib/account-client"
import {
  cloudWorkspaceLocation,
  cloudWorkspacePath,
  cloudWorkspacesClient,
  normalizeCloudRepository,
  readCloudMessages,
  readCloudModels,
  readCloudPermissions,
  readCloudQuestions,
  readCloudSessions,
  readCloudSessionStatuses,
  type CloudMessage,
  type CloudChanges,
  type CloudModel,
  type CloudPermission,
  type CloudQuestion,
  type CloudPullRequest,
  type CloudSession,
  type CloudWorkspace,
} from "../../lib/cloud-workspaces-client"
import "./cloud-workspaces.css"

type PendingPrompt = {
  requestID: string
  id?: string
  session: string
  text: string
  model: string
  state: "allocating" | "sending" | "accepted" | "uncertain"
}

export function CloudWorkspaces() {
  const [auth, setAuth] = useState<"loading" | "signed-in" | "signed-out" | "error">("loading")
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [enabled, setEnabled] = useState<boolean>()
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = useState("")
  const [sessionId, setSessionId] = useState("")
  const [sessions, setSessions] = useState<CloudSession[]>([])
  const [messages, setMessages] = useState<CloudMessage[]>([])
  const [models, setModels] = useState<CloudModel[]>([])
  const [model, setModel] = useState("")
  const [statuses, setStatuses] = useState<ReturnType<typeof readCloudSessionStatuses>>({})
  const [permissions, setPermissions] = useState<CloudPermission[]>([])
  const [questions, setQuestions] = useState<CloudQuestion[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [repository, setRepository] = useState("")
  const [branch, setBranch] = useState("")
  const [githubToken, setGithubToken] = useState("")
  const [prompt, setPrompt] = useState("")
  const [action, setAction] = useState("")
  const [loadingChat, setLoadingChat] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [review, setReview] = useState<CloudChanges>()
  const [pullRequest, setPullRequest] = useState<CloudPullRequest>()
  const [publishToken, setPublishToken] = useState("")
  const [pullRequestTitle, setPullRequestTitle] = useState("")
  const [pending, setPending] = useState<PendingPrompt>()
  const pendingPrompt = useRef<PendingPrompt>(undefined)
  const initialLocation = useRef({ workspace: "", session: "" })
  const createKey = useRef("")
  const transcript = useRef<HTMLDivElement>(null)
  const client = useMemo(() => (token ? cloudWorkspacesClient(token) : undefined), [token])
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const session = sessions.find((item) => item.id === sessionId)
  const status = statuses[sessionId]?.type ?? "idle"
  const busy = status !== "idle"

  const select = (nextWorkspace: string, nextSession = "") => {
    if (nextWorkspace !== workspaceId || nextSession !== sessionId) {
      setPrompt("")
      setPending(undefined)
      pendingPrompt.current = undefined
    }
    initialLocation.current = { workspace: nextWorkspace, session: nextSession }
    setWorkspaceId(nextWorkspace)
    setSessionId(nextSession)
    setDeleteConfirm(false)
    setNotice("")
    setError("")
    history.pushState({}, "", cloudWorkspacePath(nextWorkspace, nextSession))
  }

  useEffect(() => {
    initialLocation.current = cloudWorkspaceLocation(location.search)
    setWorkspaceId(initialLocation.current.workspace)
    setSessionId(initialLocation.current.session)
    const changed = () => {
      initialLocation.current = cloudWorkspaceLocation(location.search)
      setWorkspaceId(initialLocation.current.workspace)
      setSessionId(initialLocation.current.session)
    }
    addEventListener("popstate", changed)
    let active = true
    let unsubscribe: (() => void) | undefined
    void vectorAccountClient()
      .then(async (account) => {
        if (!active) return
        const listener = account.auth.onAuthStateChange((_event, current) => {
          if (!active) return
          setToken(current?.access_token ?? "")
          setEmail(current?.user.email ?? "")
          setAuth(current ? "signed-in" : "signed-out")
          if (!current) {
            setWorkspaces([])
            setMessages([])
            setSessions([])
            setGithubToken("")
            setPublishToken("")
            setReview(undefined)
            setPullRequest(undefined)
            setPending(undefined)
            pendingPrompt.current = undefined
            setPrompt("")
          }
        })
        unsubscribe = () => listener.data.subscription.unsubscribe()
        const current = await account.auth.getSession()
        if (current.error) throw current.error
        if (!active) return
        setToken(current.data.session?.access_token ?? "")
        setEmail(current.data.session?.user.email ?? "")
        setAuth(current.data.session ? "signed-in" : "signed-out")
      })
      .catch(() => {
        if (active) {
          setAuth("error")
          setError("Vector accounts are temporarily unavailable. Try again in a moment.")
        }
      })
    return () => {
      active = false
      unsubscribe?.()
      removeEventListener("popstate", changed)
    }
  }, [])

  useEffect(() => {
    if (!createOpen) setGithubToken("")
  }, [createOpen])

  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const result = await client.list(controller.signal)
        if (controller.signal.aborted) return
        setEnabled(result.enabled)
        setWorkspaces((current) =>
          result.workspaces.map((item) => {
            const known = current.find((prior) => prior.id === item.id)
            return known && known.revision > item.revision ? known : item
          }),
        )
        if (!initialLocation.current.workspace && result.workspaces[0]) {
          const first = result.workspaces[0].id
          initialLocation.current = { workspace: first, session: "" }
          setWorkspaceId(first)
          history.replaceState({}, "", cloudWorkspacePath(first))
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause))
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 10_000)
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [client, refresh])

  useEffect(() => {
    setSessions([])
    setMessages([])
    setModels([])
    setStatuses({})
    setPermissions([])
    setQuestions([])
    setModel("")
    setPending(undefined)
    pendingPrompt.current = undefined
    setPrompt("")
    setReview(undefined)
    setPullRequest(undefined)
    setPublishToken("")
    setPullRequestTitle("")
  }, [workspaceId])

  useEffect(() => {
    setMessages([])
  }, [sessionId])

  useEffect(() => {
    if (!client || !workspaceId || workspace?.state !== "running") return
    const controller = new AbortController()
    void client
      .engine(workspaceId, "/provider", "GET", undefined, controller.signal)
      .then(readCloudModels)
      .then((available) => {
        if (controller.signal.aborted) return
        setModels(available)
        setModel((current) =>
          available.some((item) => modelKey(item) === current)
            ? current
            : modelKey(available.find((item) => item.preferred) ?? available[0]),
        )
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause))
      })
    return () => controller.abort()
  }, [client, workspaceId, workspace?.state, refresh])

  useEffect(() => {
    if (!client || !workspaceId || workspace?.state !== "running") return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setLoadingChat(true)
    const load = async () => {
      try {
        const result = await Promise.all([
          client
            .engine(workspaceId, "/session?roots=true&limit=50", "GET", undefined, controller.signal)
            .then(readCloudSessions),
          client
            .engine(workspaceId, "/session/status", "GET", undefined, controller.signal)
            .then(readCloudSessionStatuses),
          sessionId
            ? client
                .engine(
                  workspaceId,
                  `/session/${encodeURIComponent(sessionId)}/message?limit=100`,
                  "GET",
                  undefined,
                  controller.signal,
                )
                .then(readCloudMessages)
            : Promise.resolve([]),
          client.engine(workspaceId, "/permission", "GET", undefined, controller.signal).then(readCloudPermissions),
          client.engine(workspaceId, "/question", "GET", undefined, controller.signal).then(readCloudQuestions),
        ])
        if (controller.signal.aborted) return
        setSessions(result[0])
        setStatuses(result[1])
        setMessages(result[2])
        setPermissions(result[3])
        setQuestions(result[4])
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause))
      } finally {
        if (!controller.signal.aborted) setLoadingChat(false)
      }
      if (!controller.signal.aborted) timer = setTimeout(load, document.hidden ? 20_000 : 5_000)
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [client, workspaceId, workspace?.state, sessionId, refresh])

  useEffect(() => {
    if (!pending?.id || !messages.some((item) => item.id === pending.id)) return
    setPrompt((current) => (current.trim() === pending.text ? "" : current))
    if (pendingPrompt.current?.requestID === pending.requestID) pendingPrompt.current = undefined
    setPending(undefined)
  }, [messages, pending])

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "auto" })
  }, [sessionId, messages.length])

  const updateWorkspace = (next: CloudWorkspace) => {
    setWorkspaces((current) => {
      const known = current.find((item) => item.id === next.id)
      return [known && known.revision > next.revision ? known : next, ...current.filter((item) => item.id !== next.id)]
    })
  }

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault()
    if (!client || action) return
    setError("")
    setAction("create")
    const credential = githubToken.trim()
    setGithubToken("")
    try {
      const source = normalizeCloudRepository(repository)
      createKey.current ||= crypto.randomUUID()
      const created = await client.create({
        repository: source,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        idempotencyKey: createKey.current,
        ...(credential ? { githubToken: credential } : {}),
      })
      createKey.current = ""
      updateWorkspace(created)
      select(created.id)
      setRepository("")
      setBranch("")
      setCreateOpen(false)
      setNotice("Workspace created. Its repository and chats stay with your account.")
    } catch (cause) {
      setError(message(cause))
    } finally {
      setAction("")
    }
  }

  const workspaceAction = async (command: "start" | "stop" | "delete") => {
    if (!client || !workspace || action) return
    setAction(command)
    setError("")
    try {
      if (command === "delete") {
        await client.remove(workspace.id)
        setWorkspaces((current) => current.filter((item) => item.id !== workspace.id))
        select("")
        setNotice("Workspace deleted.")
        setRefresh((current) => current + 1)
        return
      }
      updateWorkspace(await client.command(command, workspace.id))
      if (command === "start") {
        setReview(undefined)
        setPublishToken("")
      }
      setRefresh((current) => current + 1)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setAction("")
    }
  }

  const sendPrompt = async (event: FormEvent) => {
    event.preventDefault()
    if (!client || !workspace || workspace.state !== "running" || action || !prompt.trim()) return
    const selectedModel = models.find((item) => modelKey(item) === model)
    if (!selectedModel) {
      setError("Choose an available model before sending a message.")
      return
    }
    setAction("send")
    setError("")
    const text = prompt.trim()
    let target = sessionId
    let requestID = ""
    try {
      if (!target) {
        const created = readCloudSessions([
          await client.engine(workspace.id, "/session", "POST", { title: text.slice(0, 80) }),
        ])[0]
        target = created.id
        setSessions((current) => [created, ...current])
        select(workspace.id, target)
      }
      const previous = pendingPrompt.current
      const intent: PendingPrompt =
        previous?.session === target && previous.text === text && previous.model === model
          ? { ...previous, state: previous.id ? "sending" : "allocating" }
          : { requestID: crypto.randomUUID(), session: target, text, model, state: "allocating" }
      requestID = intent.requestID
      // Save the request nonce synchronously before allocation. A lost response
      // must reuse this request, and a lost prompt response must reuse its ID.
      pendingPrompt.current = intent
      setPending(intent)
      const id = intent.id ?? (await client.allocateMessageId(workspace.id, target, intent.requestID))
      const prepared: PendingPrompt = { ...intent, id, state: "sending" }
      pendingPrompt.current = prepared
      setPending(prepared)
      await client.engine(workspace.id, `/session/${encodeURIComponent(target)}/prompt_async`, "POST", {
        messageID: id,
        model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID },
        parts: [{ type: "text", text }],
      })
      if (pendingPrompt.current?.requestID === requestID) {
        const accepted: PendingPrompt = { ...prepared, state: "accepted" }
        pendingPrompt.current = accepted
        setPending((current) => (current?.requestID === requestID ? accepted : current))
      }
      if (initialLocation.current.workspace === workspace.id && initialLocation.current.session === target)
        setPrompt((current) => (current.trim() === text ? "" : current))
      setRefresh((current) => current + 1)
    } catch (cause) {
      const current = pendingPrompt.current
      if (requestID && current?.requestID === requestID) {
        const uncertain: PendingPrompt = { ...current, state: "uncertain" }
        pendingPrompt.current = uncertain
        setPending((item) => (item?.requestID === requestID ? uncertain : item))
      }
      setError(
        current?.requestID === requestID
          ? `${message(cause)} ${current.id ? "Refresh to check whether your message was saved before sending again." : "Send the same message again to retry its saved preparation request."}`
          : message(cause),
      )
    } finally {
      setAction("")
    }
  }

  const stopSession = async () => {
    if (!client || !workspaceId || !sessionId || action === "abort") return
    setAction("abort")
    setError("")
    try {
      await client.engine(workspaceId, `/session/${encodeURIComponent(sessionId)}/abort`, "POST", {})
      setNotice("Stop requested. The chat will update when the engine has stopped.")
      setRefresh((current) => current + 1)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setAction("")
    }
  }

  const replyPermission = async (id: string, reply: "once" | "reject") => {
    if (!client || !workspaceId || action) return
    setAction(`permission:${id}`)
    setError("")
    try {
      const confirmed = await client.engine(workspaceId, `/permission/${encodeURIComponent(id)}/reply`, "POST", {
        reply,
      })
      if (confirmed !== true)
        throw new Error("Vector could not confirm your approval response. Refresh before trying again.")
      setPermissions((current) => current.filter((item) => item.id !== id))
      setRefresh((current) => current + 1)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setAction("")
    }
  }

  const reviewChanges = async () => {
    if (!client || !workspace || action) return
    setAction("changes")
    setError("")
    setReview(undefined)
    setPublishToken("")
    try {
      const result = await client.changes(workspace.id)
      updateWorkspace(result.workspace)
      if (result.workspace.state !== "stopped")
        throw new Error("The workspace must be paused before its changes can be reviewed.")
      setReview(result.changes)
      setPullRequest(result.pullRequest)
      setPullRequestTitle((current) => current || `Vector: ${workspace.title}`.slice(0, 180))
      setNotice("Workspace paused. Review these exact changes before creating a draft pull request.")
    } catch (cause) {
      setError(message(cause))
    } finally {
      setAction("")
    }
  }

  const publishChanges = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !client ||
      !workspace ||
      !review ||
      workspace.state !== "stopped" ||
      !publishToken.trim() ||
      !pullRequestTitle.trim() ||
      action
    )
      return
    const credential = publishToken.trim()
    setPublishToken("")
    setAction("publish")
    setError("")
    try {
      const result = await client.publish({
        workspaceId: workspace.id,
        digest: review.digest,
        githubToken: credential,
        title: pullRequestTitle.trim(),
      })
      updateWorkspace(result.workspace)
      setPullRequest(result.pullRequest)
      setNotice("Draft pull request confirmed on GitHub. Open it to review the proposed changes.")
    } catch (cause) {
      setReview(undefined)
      setError(`${message(cause)} Pause and review changes again to check the latest result before retrying.`)
    } finally {
      setAction("")
    }
  }

  const replyQuestion = async (id: string, answers?: string[][]) => {
    if (!client || !workspaceId || action) return
    setAction(`question:${id}`)
    setError("")
    try {
      const confirmed = await client.engine(
        workspaceId,
        `/question/${encodeURIComponent(id)}/${answers ? "reply" : "reject"}`,
        "POST",
        answers ? { answers } : {},
      )
      if (confirmed !== true) throw new Error("Vector could not confirm your answer. Refresh before trying again.")
      setQuestions((current) => current.filter((item) => item.id !== id))
      setRefresh((current) => current + 1)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setAction("")
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(cloudWorkspacePath(workspaceId, sessionId), location.origin).href)
      setNotice("Link copied. Open it while signed in to the same Vector account.")
    } catch {
      setError("Your browser could not copy the link. Copy the address from your browser instead.")
    }
  }

  return (
    <main className="cw-shell">
      <header className="cw-header">
        <a href="/" className="cw-brand" aria-label="Vector home">
          <img src={vectorMark.src} alt="" />
          <span>Vector</span>
          <ChevronRight size={14} />
          <span className="cw-brand-section">Cloud workspaces</span>
        </a>
        <nav aria-label="Workspace navigation">
          <a href="/docs">Docs</a>
          <a href="/account">Account</a>
        </nav>
      </header>
      {auth !== "signed-in" ? (
        <section className="cw-door">
          <Cloud size={32} aria-hidden="true" />
          <h1>Cloud workspaces are a private pilot.</h1>
          <p>
            Open a GitHub repository, ask Vector to work on it, and return to the same cloud chats from another device.
            The pilot is not open to everyone yet. Sign in to see whether it is available for your account.
          </p>
          {auth === "loading" ? (
            <p className="cw-loading">
              <LoaderCircle size={17} />
              Checking your account…
            </p>
          ) : auth === "error" ? (
            <p role="alert" className="cw-error">
              {error}
            </p>
          ) : (
            <a
              className="cw-primary"
              href={`/login?returnTo=${encodeURIComponent(cloudWorkspacePath(workspaceId, sessionId))}`}
            >
              Sign in to Vector <ChevronRight size={16} />
            </a>
          )}
        </section>
      ) : (
        <>
          <div className="cw-account">
            <span>{email}</span>
            <span>
              <Cloud size={13} />
              Saved to your account
            </span>
          </div>
          {error && (
            <div className="cw-alert cw-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <div className="cw-alert cw-notice" role="status">
              <Check size={15} />
              <span>{notice}</span>
            </div>
          )}
          {enabled === false ? (
            <section className="cw-door cw-disabled">
              <Cloud size={28} />
              <h1>Cloud workspaces aren’t available yet.</h1>
              <p>
                Your account is signed in. Workspace creation will be available here when the cloud service is enabled.
              </p>
              <button
                type="button"
                className="cw-secondary"
                onClick={() => {
                  setError("")
                  setRefresh((current) => current + 1)
                }}
              >
                <RefreshCw size={15} />
                Check again
              </button>
            </section>
          ) : (
            <div className="cw-console">
              <aside className="cw-sidebar" aria-label="Your workspaces and chats">
                <div className="cw-sidebar-heading">
                  <h2>Workspaces</h2>
                  <button
                    type="button"
                    title="New workspace"
                    aria-label="New workspace"
                    disabled={enabled !== true || Boolean(action)}
                    onClick={() => setCreateOpen((current) => !current)}
                  >
                    <Plus size={17} />
                  </button>
                </div>
                {enabled === undefined && <p className="cw-muted cw-padding">Loading workspaces…</p>}
                {enabled === true && workspaces.length === 0 && (
                  <p className="cw-muted cw-padding">Create a workspace to start coding.</p>
                )}
                <div className="cw-workspace-list">
                  {workspaces.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`cw-workspace ${item.id === workspaceId ? "cw-selected" : ""}`}
                      aria-current={item.id === workspaceId ? "page" : undefined}
                      disabled={Boolean(action)}
                      onClick={() => select(item.id)}
                    >
                      <span className={`cw-state cw-state-${item.state}`} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.repository}</small>
                      </span>
                      <span className="cw-state-label">{item.state}</span>
                    </button>
                  ))}
                </div>
                {workspace && (
                  <div className="cw-sessions">
                    <div className="cw-sidebar-heading">
                      <h2>Cloud chats</h2>
                      <button
                        type="button"
                        title="New chat"
                        aria-label="New chat"
                        disabled={workspace.state !== "running" || Boolean(action)}
                        onClick={() => select(workspace.id)}
                      >
                        <Plus size={17} />
                      </button>
                    </div>
                    {sessions.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`cw-session ${item.id === sessionId ? "cw-selected" : ""}`}
                        aria-current={item.id === sessionId ? "page" : undefined}
                        disabled={Boolean(action)}
                        onClick={() => select(workspace.id, item.id)}
                      >
                        <MessageSquare size={14} />
                        <span>{item.title}</span>
                        {statuses[item.id]?.type && <span className="cw-activity" aria-label="Chat active" />}
                      </button>
                    ))}
                    {sessions.length === 0 && (
                      <p className="cw-muted cw-padding">
                        {workspace.state === "running"
                          ? "Your saved chats will appear here."
                          : "Start the workspace to open its chats."}
                      </p>
                    )}
                  </div>
                )}
                <p className="cw-sidebar-note">
                  Chats belong to your account. Copy a chat link to pick up where you left off on another device.
                </p>
              </aside>
              <section className="cw-main" aria-label="Cloud coding workspace">
                {createOpen ? (
                  <form className="cw-create" onSubmit={createWorkspace}>
                    <span className="cw-eyebrow">New workspace</span>
                    <h1>Start with a repository.</h1>
                    <p>Vector will open a separate cloud workspace for your code.</p>
                    <label htmlFor="cw-repository">GitHub repository</label>
                    <input
                      id="cw-repository"
                      autoComplete="off"
                      placeholder="owner/repository"
                      value={repository}
                      maxLength={220}
                      required
                      onChange={(event) => {
                        setRepository(event.target.value)
                        createKey.current = ""
                      }}
                    />
                    <label htmlFor="cw-branch">
                      Branch or ref <span>Optional</span>
                    </label>
                    <input
                      id="cw-branch"
                      autoComplete="off"
                      placeholder="main"
                      value={branch}
                      maxLength={200}
                      onChange={(event) => {
                        setBranch(event.target.value)
                        createKey.current = ""
                      }}
                    />
                    <details className="cw-private-repo">
                      <summary>Using a private repository?</summary>
                      <label htmlFor="cw-github-token">GitHub access token</label>
                      <input
                        id="cw-github-token"
                        type="password"
                        autoComplete="new-password"
                        value={githubToken}
                        maxLength={500}
                        onChange={(event) => setGithubToken(event.target.value)}
                      />
                      <p>Provide access to this repository. The token is cleared from this form when you submit it.</p>
                    </details>
                    <div className="cw-form-actions">
                      <button className="cw-primary" type="submit" disabled={Boolean(action) || !repository.trim()}>
                        {action === "create" ? <LoaderCircle size={16} /> : <Plus size={16} />}
                        {action === "create" ? "Creating workspace…" : "Create workspace"}
                      </button>
                      <button
                        type="button"
                        className="cw-secondary"
                        disabled={Boolean(action)}
                        onClick={() => {
                          setCreateOpen(false)
                          setGithubToken("")
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : !workspace ? (
                  <div className="cw-empty">
                    <Cloud size={34} />
                    <h1>{workspaceId ? "Workspace unavailable" : "Code from anywhere."}</h1>
                    <p>
                      {workspaceId
                        ? "This workspace is unavailable for your account. Choose another workspace or refresh the list."
                        : "Bring a GitHub repository into Vector. Your code and cloud chats will be here when you return."}
                    </p>
                    <button
                      type="button"
                      className="cw-primary"
                      disabled={enabled !== true}
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus size={16} />
                      New workspace
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="cw-workspace-bar">
                      <div>
                        <h1>{workspace.title}</h1>
                        <p>
                          <span>{workspace.repository}</span>
                          <GitBranch size={13} />
                          <span>{workspace.branch}</span>
                        </p>
                      </div>
                      <div className="cw-toolbar">
                        <span className={`cw-status cw-status-${workspace.state}`}>
                          <span className={`cw-state cw-state-${workspace.state}`} />
                          {workspace.state}
                        </span>
                        <button
                          type="button"
                          className="cw-icon-button"
                          title="Refresh workspace"
                          aria-label="Refresh workspace"
                          onClick={() => {
                            setError("")
                            setRefresh((current) => current + 1)
                          }}
                        >
                          <RefreshCw size={15} />
                        </button>
                        <button
                          type="button"
                          className="cw-icon-button"
                          title="Copy chat link"
                          aria-label="Copy chat link"
                          onClick={copyLink}
                        >
                          <Copy size={15} />
                        </button>
                        {(workspace.state === "running" || workspace.state === "stopped") && (
                          <button
                            type="button"
                            className="cw-secondary"
                            disabled={Boolean(action)}
                            onClick={reviewChanges}
                          >
                            <GitPullRequest size={14} />
                            {action === "changes" ? "Pausing and reviewing…" : "Pause and review changes"}
                          </button>
                        )}
                        {workspace.state === "running" ? (
                          <button
                            className="cw-secondary"
                            type="button"
                            disabled={Boolean(action)}
                            onClick={() => workspaceAction("stop")}
                          >
                            <Square size={12} />
                            Pause
                          </button>
                        ) : (
                          workspace.state !== "creating" && (
                            <button
                              className="cw-primary"
                              type="button"
                              disabled={Boolean(action)}
                              onClick={() => workspaceAction("start")}
                            >
                              Start workspace
                            </button>
                          )
                        )}
                        <button
                          type="button"
                          className="cw-icon-button"
                          title="Delete workspace"
                          aria-label="Delete workspace"
                          disabled={Boolean(action) || workspace.state === "creating"}
                          onClick={() => setDeleteConfirm((current) => !current)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                    {deleteConfirm && (
                      <div className="cw-delete-confirm">
                        <p>Delete this workspace and its saved cloud chats? This cannot be undone.</p>
                        <button
                          type="button"
                          className="cw-danger"
                          disabled={Boolean(action)}
                          onClick={() => workspaceAction("delete")}
                        >
                          Delete workspace
                        </button>
                        <button type="button" className="cw-secondary" onClick={() => setDeleteConfirm(false)}>
                          Keep workspace
                        </button>
                      </div>
                    )}
                    {pullRequest && (
                      <section className="cw-published" aria-label="Confirmed draft pull request">
                        <GitPullRequest size={18} />
                        <div>
                          <strong>Draft pull request on GitHub</strong>
                          <a href={pullRequest.url} target="_blank" rel="noopener noreferrer">
                            Open draft pull request <ChevronRight size={14} />
                          </a>
                          <small>
                            {pullRequest.branch} · {pullRequest.commit.slice(0, 12)}
                          </small>
                        </div>
                      </section>
                    )}
                    {review && (
                      <section className="cw-review" aria-label="Review workspace changes">
                        <header>
                          <div>
                            <span className="cw-eyebrow">Paused for your review</span>
                            <h2>Changes in this workspace</h2>
                          </div>
                          <code title={review.digest}>Review {review.digest.slice(0, 12)}</code>
                        </header>
                        <ul className="cw-changed-files">
                          {review.files.map((file) => (
                            <li key={file}>{file}</li>
                          ))}
                        </ul>
                        {review.diff ? (
                          <pre className="cw-diff" tabIndex={0} aria-label="Reviewed diff">
                            {review.diff}
                          </pre>
                        ) : (
                          <p className="cw-muted">There are no changes to publish.</p>
                        )}
                        {!pullRequest && review.files.length > 0 && (
                          <form className="cw-publish-form" onSubmit={publishChanges}>
                            <label htmlFor="cw-pr-title">
                              Pull request title
                              <input
                                id="cw-pr-title"
                                value={pullRequestTitle}
                                maxLength={180}
                                required
                                disabled={Boolean(action)}
                                onChange={(event) => setPullRequestTitle(event.target.value)}
                              />
                            </label>
                            <label htmlFor="cw-publish-token">
                              GitHub access token
                              <input
                                id="cw-publish-token"
                                type="password"
                                autoComplete="new-password"
                                value={publishToken}
                                maxLength={500}
                                required
                                disabled={Boolean(action)}
                                onChange={(event) => setPublishToken(event.target.value)}
                              />
                            </label>
                            <p>
                              Use a token with permission to push a branch and open a pull request in{" "}
                              {workspace.repository}. It is cleared from this form when submitted. The workspace stays
                              paused while these changes are checked again.
                            </p>
                            <button
                              type="submit"
                              className="cw-primary"
                              disabled={
                                Boolean(action) ||
                                workspace.state !== "stopped" ||
                                !publishToken.trim() ||
                                !pullRequestTitle.trim()
                              }
                            >
                              <GitPullRequest size={15} />
                              {action === "publish" ? "Creating draft pull request…" : "Publish draft pull request"}
                            </button>
                          </form>
                        )}
                      </section>
                    )}
                    {workspace.state !== "running" ? (
                      <div className="cw-empty">
                        <Cloud size={30} />
                        <h2>
                          {workspace.state === "creating"
                            ? "Preparing your workspace…"
                            : workspace.state === "stopped"
                              ? "Your workspace is paused."
                              : "The workspace needs attention."}
                        </h2>
                        <p>
                          {workspace.state === "creating"
                            ? "Your repository is being prepared. This page will update when it is ready."
                            : "Start the workspace to load its saved chats and continue coding."}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="cw-chat-heading">
                          <h2>{session?.title ?? (sessionId ? "Cloud chat" : "New chat")}</h2>
                          <span className="cw-muted">
                            {loadingChat
                              ? "Loading…"
                              : permissions.some((item) => item.sessionID === sessionId)
                                ? "Waiting for your approval"
                                : questions.some((item) => item.sessionID === sessionId)
                                  ? "Waiting for your answer"
                                  : status === "retry"
                                    ? (statuses[sessionId]?.message ?? "Waiting to retry…")
                                    : busy
                                      ? "Vector is working…"
                                      : "Ready"}
                          </span>
                        </div>
                        <div
                          className="cw-transcript"
                          ref={transcript}
                          aria-label="Chat messages"
                          aria-busy={loadingChat}
                        >
                          {!loadingChat && messages.length === 0 && (
                            <div className="cw-chat-empty">
                              <MessageSquare size={25} />
                              <h2>What would you like to build?</h2>
                              <p>Ask Vector to explore the repository, fix a bug, or work on a feature.</p>
                            </div>
                          )}
                          {messages.length >= 100 && (
                            <p className="cw-muted">Showing the latest 100 messages in this chat.</p>
                          )}
                          {messages.map((item) => (
                            <Message key={item.id} message={item} />
                          ))}
                          {permissions
                            .filter((item) => item.sessionID === sessionId)
                            .map((item) => (
                              <section key={item.id} className="cw-approval">
                                <span className="cw-eyebrow">Approval needed</span>
                                <h3>Allow {item.permission}?</h3>
                                <ul>
                                  {item.patterns.map((pattern, index) => (
                                    <li key={index}>
                                      <code>{pattern}</code>
                                    </li>
                                  ))}
                                </ul>
                                <p>Allow applies to this request once.</p>
                                <div>
                                  <button
                                    type="button"
                                    className="cw-secondary"
                                    disabled={Boolean(action)}
                                    onClick={() => replyPermission(item.id, "reject")}
                                  >
                                    Deny
                                  </button>
                                  <button
                                    type="button"
                                    className="cw-primary"
                                    disabled={Boolean(action)}
                                    onClick={() => replyPermission(item.id, "once")}
                                  >
                                    Allow once
                                  </button>
                                </div>
                              </section>
                            ))}
                          {questions
                            .filter((item) => item.sessionID === sessionId)
                            .map((item) => (
                              <Question
                                key={item.id}
                                question={item}
                                disabled={Boolean(action)}
                                onReply={(answers) => replyQuestion(item.id, answers)}
                              />
                            ))}
                          {pending?.session === sessionId && !messages.some((item) => item.id === pending.id) && (
                            <p className="cw-pending" role="status">
                              <LoaderCircle size={14} />
                              {pending.state === "allocating"
                                ? "Preparing your message…"
                                : pending.state === "sending"
                                  ? "Sending your message…"
                                  : pending.state === "accepted"
                                    ? "Message accepted. Waiting for the saved chat to update…"
                                    : pending.id
                                      ? "Message delivery is unconfirmed. Refresh before sending again."
                                      : "Message preparation is unconfirmed. Sending again will reuse the same request."}
                            </p>
                          )}
                        </div>
                        <form className="cw-composer" onSubmit={sendPrompt}>
                          <label className="cw-sr-only" htmlFor="cw-prompt">
                            Message Vector
                          </label>
                          <textarea
                            id="cw-prompt"
                            placeholder="Ask Vector to work on this repository…"
                            value={prompt}
                            maxLength={50_000}
                            rows={3}
                            disabled={action === "send"}
                            onChange={(event) => setPrompt(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault()
                                event.currentTarget.form?.requestSubmit()
                              }
                            }}
                          />
                          <div className="cw-composer-bottom">
                            <label className="cw-sr-only" htmlFor="cw-model">
                              Model
                            </label>
                            <select
                              id="cw-model"
                              value={model}
                              disabled={models.length === 0 || action === "send"}
                              onChange={(event) => setModel(event.target.value)}
                            >
                              {models.length === 0 ? (
                                <option value="">No models available</option>
                              ) : (
                                models.map((item) => (
                                  <option key={modelKey(item)} value={modelKey(item)}>
                                    {item.name} · {item.provider}
                                  </option>
                                ))
                              )}
                            </select>
                            <div>
                              {busy && (
                                <button
                                  type="button"
                                  className="cw-secondary"
                                  disabled={action === "abort"}
                                  onClick={stopSession}
                                >
                                  <Square size={12} />
                                  Stop
                                </button>
                              )}
                              <button
                                type="submit"
                                className="cw-send"
                                disabled={Boolean(action) || !prompt.trim() || !model}
                                aria-label={busy ? "Send follow-up" : "Send message"}
                              >
                                {action === "send" ? <LoaderCircle size={18} /> : <ArrowUp size={18} />}
                              </button>
                            </div>
                          </div>
                          {models.length === 0 && !loadingChat && (
                            <p className="cw-composer-note">
                              No connected models are available in this workspace. Refresh after a model has been
                              configured.
                            </p>
                          )}
                          <p className="cw-composer-note">
                            {busy
                              ? "A follow-up is sent to the active chat. Stop ends the current work."
                              : "Messages and replies are saved in this workspace."}{" "}
                            <span>⌘ / Ctrl + Enter to send</span>
                          </p>
                        </form>
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </main>
  )
}

function Message(props: { message: CloudMessage }) {
  const item = props.message
  return (
    <article className={`cw-message cw-message-${item.role}`}>
      <header>
        <span>{item.role === "user" ? "You" : "Vector"}</span>
        <time dateTime={new Date(item.createdAt).toISOString()}>
          {new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </time>
        {!item.completed && <span className="cw-muted">Working…</span>}
      </header>
      <div className="cw-message-body">
        {item.parts.map((part) => {
          if (part.type === "text")
            return (
              <div className="cw-message-text" key={part.id}>
                {part.text}
              </div>
            )
          if (part.type === "reasoning")
            return (
              <details className="cw-tool" key={part.id}>
                <summary>Reasoning</summary>
                <div className="cw-message-text">{part.text}</div>
              </details>
            )
          if (part.type === "tool")
            return (
              <details className="cw-tool" key={part.id}>
                <summary>
                  <span>{part.title}</span>
                  <span className="cw-muted">{part.status}</span>
                </summary>
                {part.output ? (
                  <pre>
                    {part.output.slice(0, 50_000)}
                    {part.output.length > 50_000 ? "\n…Output shortened for display." : ""}
                  </pre>
                ) : (
                  <p className="cw-muted">
                    {part.name} · {part.status}
                  </p>
                )}
              </details>
            )
          if (part.type === "patch")
            return (
              <div className="cw-file" key={part.id}>
                Changed files: {part.files.join(", ")}
              </div>
            )
          if (part.type === "file")
            return (
              <div className="cw-file" key={part.id}>
                {part.name}
              </div>
            )
          return null
        })}
        {item.error && (
          <p className="cw-error" role="alert">
            {item.error}
          </p>
        )}
      </div>
    </article>
  )
}

function Question(props: {
  question: CloudQuestion
  disabled: boolean
  onReply: (answers?: string[][]) => Promise<void>
}) {
  const [answers, setAnswers] = useState<string[][]>(props.question.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(props.question.questions.map(() => ""))
  const complete = props.question.questions.every(
    (_question, index) => answers[index].length > 0 || custom[index].trim(),
  )
  return (
    <form
      className="cw-approval"
      onSubmit={(event) => {
        event.preventDefault()
        if (complete)
          void props.onReply(
            answers.map((answer, index) => (custom[index].trim() ? [...answer, custom[index].trim()] : answer)),
          )
      }}
    >
      <span className="cw-eyebrow">Vector has a question</span>
      {props.question.questions.map((question, index) => (
        <fieldset key={index}>
          <legend>{question.header}</legend>
          <p>{question.question}</p>
          {question.options.map((option) => (
            <label className="cw-question-option" key={option.label}>
              <input
                type={question.multiple ? "checkbox" : "radio"}
                name={`cw-question-${props.question.id}-${index}`}
                checked={answers[index].includes(option.label)}
                disabled={props.disabled}
                onChange={(event) => {
                  setAnswers((current) =>
                    current.map((value, position) =>
                      position !== index
                        ? value
                        : question.multiple
                          ? event.target.checked
                            ? [...value, option.label]
                            : value.filter((label) => label !== option.label)
                          : [option.label],
                    ),
                  )
                  if (!question.multiple)
                    setCustom((current) => current.map((value, position) => (position === index ? "" : value)))
                }}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
          {question.custom && (
            <label className="cw-question-custom">
              Your answer
              <input
                value={custom[index]}
                disabled={props.disabled}
                maxLength={4000}
                placeholder="Or write an answer…"
                onChange={(event) => {
                  setCustom((current) =>
                    current.map((value, position) => (position === index ? event.target.value : value)),
                  )
                  if (!question.multiple)
                    setAnswers((current) => current.map((value, position) => (position === index ? [] : value)))
                }}
              />
            </label>
          )}
        </fieldset>
      ))}
      <div>
        <button type="button" className="cw-secondary" disabled={props.disabled} onClick={() => props.onReply()}>
          Skip question
        </button>
        <button type="submit" className="cw-primary" disabled={props.disabled || !complete}>
          Send answer
        </button>
      </div>
    </form>
  )
}

function modelKey(model?: CloudModel) {
  return model ? JSON.stringify([model.providerID, model.modelID]) : ""
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Vector could not complete this request. Try again."
}
