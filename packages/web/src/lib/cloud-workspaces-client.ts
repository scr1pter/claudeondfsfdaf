export type CloudWorkspace = {
  id: string
  repository: string
  branch: string
  title: string
  state: "creating" | "running" | "stopped" | "error"
  createdAt: number
  updatedAt: number
  revision: number
}

export type CloudSession = { id: string; title: string; updatedAt: number }
export type CloudModel = { providerID: string; modelID: string; name: string; provider: string; preferred: boolean }
export type CloudPullRequest = { url: string; branch: string; commit: string }
export type CloudChanges = { digest: string; diff: string; files: string[] }
export type CloudPermission = { id: string; sessionID: string; permission: string; patterns: string[] }
export type CloudQuestion = {
  id: string
  sessionID: string
  questions: {
    header: string
    question: string
    options: { label: string; description: string }[]
    multiple: boolean
    custom: boolean
  }[]
}
export type CloudMessage = {
  id: string
  role: "user" | "assistant"
  createdAt: number
  completed: boolean
  error?: string
  parts: (
    | { id: string; type: "text" | "reasoning"; text: string }
    | { id: string; type: "tool"; name: string; status: string; title: string; output?: string }
    | { id: string; type: "file"; name: string }
    | { id: string; type: "patch"; files: string[] }
  )[]
}

export function cloudWorkspacesClient(
  accessToken: string,
  request: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
) {
  const send = async (body?: unknown, signal?: AbortSignal) => {
    const response = await request("/api/cloud-workspaces", {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      cache: "no-store",
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
    if (response.ok && response.status === 204) return null
    const payload: unknown = response.headers.get("content-type")?.includes("json")
      ? await response.json().catch(() => undefined)
      : undefined
    if (!response.ok) {
      const detail = record(payload) && record(payload.error) ? payload.error.message : undefined
      throw new Error(
        typeof detail === "string" && detail.trim()
          ? detail.slice(0, 600)
          : response.status === 401
            ? "Sign in again to open your cloud workspaces."
            : "Vector could not reach your cloud workspace. Please try again.",
      )
    }
    if (payload === undefined) throw new Error("Vector received an incomplete cloud workspace response.")
    return payload
  }
  return {
    async list(signal?: AbortSignal) {
      const value = await send(undefined, signal)
      if (!record(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.workspaces))
        throw new Error("Vector could not read your cloud workspaces.")
      return { enabled: value.enabled, workspaces: value.workspaces.map(readCloudWorkspace) }
    },
    async create(input: {
      repository: string
      branch?: string
      title?: string
      idempotencyKey: string
      githubToken?: string
    }) {
      const value = await send({ action: "create", ...input })
      if (!record(value)) throw new Error("Vector could not read the created workspace.")
      return readCloudWorkspace(value.workspace)
    },
    async command(action: "start" | "stop", workspaceId: string) {
      const value = await send({ action, workspaceId })
      if (!record(value)) throw new Error("Vector could not read the updated workspace.")
      return readCloudWorkspace(value.workspace)
    },
    async remove(workspaceId: string) {
      const value = await send({ action: "delete", workspaceId })
      if (!record(value) || value.deleted !== true) throw new Error("Vector could not confirm workspace deletion.")
    },
    async changes(workspaceId: string) {
      const value = await send({ action: "changes", workspaceId })
      if (!record(value)) throw new Error("Vector could not read the paused workspace's changes.")
      return {
        workspace: readCloudWorkspace(value.workspace),
        changes: readCloudChanges(value.changes),
        ...(value.pullRequest === undefined ? {} : { pullRequest: readCloudPullRequest(value.pullRequest) }),
      }
    },
    async publish(input: { workspaceId: string; digest: string; githubToken: string; title: string }) {
      const value = await send({ action: "publish", ...input })
      if (!record(value))
        throw new Error("Vector could not confirm a draft pull request. Review changes again before retrying.")
      return { workspace: readCloudWorkspace(value.workspace), pullRequest: readCloudPullRequest(value.pullRequest) }
    },
    async allocateMessageId(workspaceId: string, sessionId: string, requestID: string) {
      const value = await send({
        action: "engine",
        workspaceId,
        path: `/session/${encodeURIComponent(sessionId)}/message_id`,
        method: "POST",
        body: { requestID },
      })
      if (
        !record(value) ||
        typeof value.messageID !== "string" ||
        !/^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/.test(value.messageID)
      )
        throw new Error("Vector could not prepare a message identifier. Retry the same message request.")
      return value.messageID
    },
    engine(workspaceId: string, path: string, method: "GET" | "POST" = "GET", body?: unknown, signal?: AbortSignal) {
      return send({ action: "engine", workspaceId, path, method, ...(body === undefined ? {} : { body }) }, signal)
    },
  }
}

export function readCloudChanges(value: unknown): CloudChanges {
  if (
    !record(value) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.diff !== "string" ||
    !Array.isArray(value.files) ||
    !value.files.every((file) => typeof file === "string" && file.length > 0)
  )
    throw new Error("Vector could not read the reviewed changes.")
  return { digest: value.digest, diff: value.diff, files: value.files as string[] }
}

export function readCloudPullRequest(value: unknown): CloudPullRequest {
  if (
    !record(value) ||
    typeof value.url !== "string" ||
    !string(value.branch) ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.commit)
  )
    throw new Error("Vector could not confirm the draft pull request.")
  const url = new URL(value.url)
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(url.pathname)
  )
    throw new Error("Vector received an unexpected pull request link.")
  return { url: url.href, branch: value.branch, commit: value.commit }
}

export function readCloudWorkspace(value: unknown): CloudWorkspace {
  if (
    !record(value) ||
    !string(value.id) ||
    !string(value.repository) ||
    !string(value.branch) ||
    !string(value.title) ||
    !["creating", "running", "stopped", "error"].includes(String(value.state)) ||
    !number(value.createdAt) ||
    !number(value.updatedAt) ||
    !number(value.revision)
  )
    throw new Error("Vector could not read a cloud workspace.")
  return {
    id: value.id,
    repository: value.repository,
    branch: value.branch,
    title: value.title,
    state: value.state as CloudWorkspace["state"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
  }
}

export function readCloudSessions(value: unknown): CloudSession[] {
  if (!Array.isArray(value)) throw new Error("Vector could not read your saved cloud chats.")
  return value
    .map((item) => {
      if (
        !record(item) ||
        !string(item.id) ||
        typeof item.title !== "string" ||
        !record(item.time) ||
        !number(item.time.updated)
      )
        throw new Error("Vector could not read a saved cloud chat.")
      return { id: item.id, title: item.title || "Untitled chat", updatedAt: item.time.updated }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function readCloudModels(value: unknown): CloudModel[] {
  if (
    !record(value) ||
    !Array.isArray(value.all) ||
    !Array.isArray(value.connected) ||
    !value.connected.every((item) => typeof item === "string") ||
    !record(value.default)
  )
    throw new Error("Vector could not load the workspace's models.")
  const connected = value.connected
  const defaults = value.default
  return value.all.flatMap((provider) => {
    if (!record(provider) || !string(provider.id) || !string(provider.name) || !record(provider.models))
      throw new Error("Vector could not read a model provider.")
    if (!connected.includes(provider.id)) return []
    return Object.entries(provider.models).flatMap(([id, model]) => {
      if (!record(model) || !string(model.name) || model.status === "deprecated") return []
      return [
        {
          providerID: provider.id as string,
          modelID: id,
          name: model.name,
          provider: provider.name as string,
          preferred: defaults[provider.id as string] === id,
        },
      ]
    })
  })
}

export function readCloudMessages(value: unknown): CloudMessage[] {
  if (!Array.isArray(value)) throw new Error("Vector could not read this cloud chat.")
  return value.map((item) => {
    if (
      !record(item) ||
      !record(item.info) ||
      !string(item.info.id) ||
      (item.info.role !== "user" && item.info.role !== "assistant") ||
      !record(item.info.time) ||
      !number(item.info.time.created) ||
      !Array.isArray(item.parts)
    )
      throw new Error("Vector could not read a cloud chat message.")
    const info = item.info
    const parts = item.parts.flatMap((part): CloudMessage["parts"] => {
      if (!record(part) || !string(part.id)) return []
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string")
        return part.ignored === true ? [] : [{ id: part.id, type: part.type, text: part.text }]
      if (part.type === "tool" && string(part.tool) && record(part.state) && string(part.state.status))
        return [
          {
            id: part.id,
            type: "tool",
            name: part.tool,
            status: part.state.status,
            title: typeof part.state.title === "string" ? part.state.title : part.tool,
            ...(typeof part.state.output === "string"
              ? { output: part.state.output }
              : typeof part.state.error === "string"
                ? { output: part.state.error }
                : {}),
          },
        ]
      if (part.type === "file")
        return [
          { id: part.id, type: "file", name: typeof part.filename === "string" ? part.filename : "Attached file" },
        ]
      if (part.type === "patch" && Array.isArray(part.files))
        return [
          { id: part.id, type: "patch", files: part.files.filter((file): file is string => typeof file === "string") },
        ]
      return []
    })
    const error =
      record(info.error) && record(info.error.data) && typeof info.error.data.message === "string"
        ? info.error.data.message
        : undefined
    return {
      id: info.id as string,
      role: info.role as CloudMessage["role"],
      createdAt: (info.time as Record<string, unknown>).created as number,
      completed: info.role === "user" || number((info.time as Record<string, unknown>).completed),
      ...(error ? { error } : {}),
      parts,
    }
  })
}

export function readCloudSessionStatuses(value: unknown) {
  if (!record(value)) throw new Error("Vector could not read cloud chat activity.")
  return Object.fromEntries(
    Object.entries(value).map(([id, status]) => {
      if (!record(status) || !["idle", "busy", "retry"].includes(String(status.type)))
        throw new Error("Vector could not read cloud chat activity.")
      return [
        id,
        {
          type: status.type as "idle" | "busy" | "retry",
          ...(typeof status.message === "string" ? { message: status.message } : {}),
        },
      ]
    }),
  )
}

export function readCloudPermissions(value: unknown): CloudPermission[] {
  if (!Array.isArray(value)) throw new Error("Vector could not read pending approvals.")
  return value.map((item) => {
    if (
      !record(item) ||
      !string(item.id) ||
      !string(item.sessionID) ||
      !string(item.permission) ||
      !Array.isArray(item.patterns) ||
      !item.patterns.every((pattern) => typeof pattern === "string")
    )
      throw new Error("Vector could not read a pending approval.")
    return { id: item.id, sessionID: item.sessionID, permission: item.permission, patterns: item.patterns as string[] }
  })
}

export function readCloudQuestions(value: unknown): CloudQuestion[] {
  if (!Array.isArray(value)) throw new Error("Vector could not read pending questions.")
  return value.map((item) => {
    if (!record(item) || !string(item.id) || !string(item.sessionID) || !Array.isArray(item.questions))
      throw new Error("Vector could not read a pending question.")
    const questions = item.questions.map((question) => {
      if (
        !record(question) ||
        typeof question.header !== "string" ||
        !string(question.question) ||
        !Array.isArray(question.options)
      )
        throw new Error("Vector could not read a pending question.")
      const options = question.options.map((option) => {
        if (!record(option) || !string(option.label) || typeof option.description !== "string")
          throw new Error("Vector could not read a question option.")
        return { label: option.label, description: option.description }
      })
      return {
        header: question.header,
        question: question.question,
        options,
        multiple: question.multiple === true,
        custom: question.custom !== false,
      }
    })
    return { id: item.id, sessionID: item.sessionID, questions }
  })
}

export function cloudWorkspaceLocation(search: string) {
  const query = new URLSearchParams(search)
  return { workspace: query.get("workspace") ?? "", session: query.get("session") ?? "" }
}

export function cloudWorkspacePath(workspace: string, session = "") {
  const query = new URLSearchParams()
  if (workspace) query.set("workspace", workspace)
  if (workspace && session) query.set("session", session)
  return `/workspaces${query.size ? `?${query}` : ""}`
}

export function normalizeCloudRepository(value: string) {
  const repository = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    /\/(?:\.|\.\.)$/.test(repository)
  )
    throw new Error("Enter a GitHub repository as owner/repository or its HTTPS GitHub URL.")
  return repository
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
