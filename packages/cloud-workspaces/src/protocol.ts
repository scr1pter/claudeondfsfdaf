export type CloudWorkspace = {
  id: string
  repository: string
  branch: string
  title: string
  state: "creating" | "running" | "stopped" | "error"
  createdAt: number
  updatedAt: number
  revision: number
  /**
   * Whole percentages (0-100, rounded down) of the lifetime model-request allowance and of the current Start's running
   * time. A host from before this field omits it.
   */
  usage?: { model: number; time: number }
}

export type EngineCommand = {
  action: "engine"
  workspaceId: string
  path: string
  method: "GET" | "POST"
  body?: unknown
}
export type CloudCommand =
  | {
      action: "create"
      repository: string
      branch: string
      title: string
      idempotencyKey: string
      githubToken?: string
    }
  | { action: "start" | "stop" | "delete"; workspaceId: string }
  | { action: "changes"; workspaceId: string }
  | { action: "publish"; workspaceId: string; digest: string; githubToken: string; title: string }
  | EngineCommand

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export const workspaceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export const accountId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function parsePublicWorkspace(value: unknown): CloudWorkspace {
  if (!record(value)) return invalid()
  fields(value, ["id", "repository", "branch", "title", "state", "createdAt", "updatedAt", "revision", "usage"])
  if (
    !workspaceId(value.id) ||
    typeof value.repository !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.title !== "string" ||
    typeof value.state !== "string" ||
    !["creating", "running", "stopped", "error"].includes(value.state) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.updatedAt !== "number" ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    return invalid()
  // The browser repeats this `usage` rule in readCloudWorkspace (packages/web/src/lib/cloud-workspaces-client.ts),
  // which cannot import this package; change both together, or the console hides every workspace.
  const usage = value.usage
  if (usage !== undefined) {
    if (!record(usage)) return invalid()
    fields(usage, ["model", "time"])
    if (
      ![usage.model, usage.time].every(
        (part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0 && part <= 100,
      )
    )
      return invalid()
  }
  // Reuse the input boundary without allowing any private record fields through.
  parseCommand({
    action: "create",
    repository: value.repository,
    branch: value.branch,
    title: value.title,
    idempotencyKey: value.id,
  })
  return {
    id: value.id,
    repository: value.repository,
    branch: value.branch,
    title: value.title,
    state: value.state as CloudWorkspace["state"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    ...(record(usage) ? { usage: { model: usage.model as number, time: usage.time as number } } : {}),
  }
}

function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}

export function parseCommand(value: unknown): CloudCommand {
  if (!record(value)) return invalid()
  if (value.action === "create") {
    fields(value, ["action", "repository", "branch", "title", "idempotencyKey", "githubToken"])
    if (
      typeof value.repository !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repository) ||
      value.repository.split("/")[1] === "." ||
      value.repository.split("/")[1] === ".." ||
      !workspaceId(value.idempotencyKey)
    )
      return invalid()
    const branch = value.branch ?? "main"
    if (typeof branch !== "string" || !validBranch(branch)) return invalid()
    const title = value.title ?? value.repository
    if (typeof title !== "string" || !title.trim() || title.length > 100 || /[\x00-\x1f\x7f]/.test(title))
      return invalid()
    if (
      value.githubToken !== undefined &&
      (typeof value.githubToken !== "string" || !/^[A-Za-z0-9_]{20,512}$/.test(value.githubToken))
    )
      return invalid()
    return {
      action: "create",
      repository: value.repository,
      branch,
      title: title.trim(),
      idempotencyKey: value.idempotencyKey,
      ...(typeof value.githubToken === "string" ? { githubToken: value.githubToken } : {}),
    }
  }
  if (!workspaceId(value.workspaceId)) return invalid()
  if (value.action === "start" || value.action === "stop" || value.action === "delete" || value.action === "changes") {
    fields(value, ["action", "workspaceId"])
    return { action: value.action, workspaceId: value.workspaceId }
  }
  if (value.action === "publish") {
    fields(value, ["action", "workspaceId", "digest", "githubToken", "title"])
    if (
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.githubToken !== "string" ||
      !/^[A-Za-z0-9_]{20,512}$/.test(value.githubToken) ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      value.title.length > 200 ||
      /[\x00-\x1f\x7f]/.test(value.title)
    )
      return invalid()
    return {
      action: "publish",
      workspaceId: value.workspaceId,
      digest: value.digest,
      githubToken: value.githubToken,
      title: value.title.trim(),
    }
  }
  if (
    value.action !== "engine" ||
    typeof value.path !== "string" ||
    (value.method !== "GET" && value.method !== "POST")
  )
    return invalid()
  fields(value, ["action", "workspaceId", "path", "method", "body"])
  const command: EngineCommand = {
    action: "engine",
    workspaceId: value.workspaceId,
    path: String(value.path),
    method: value.method,
    ...(value.body !== undefined ? { body: value.body } : {}),
  }
  validateEngineCommand(command)
  return command
}

function validBranch(value: string) {
  return (
    value.length <= 180 &&
    /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  )
}

export function validateEngineCommand(command: EngineCommand) {
  if (typeof command.path !== "string" || command.path.length > 512 || /[%\\#\x00-\x20]/.test(command.path))
    return invalid()
  const url = new URL(command.path, "http://engine.invalid")
  if (url.origin !== "http://engine.invalid" || command.path[0] !== "/" || command.path.startsWith("//"))
    return invalid()
  const path = url.pathname
  // The supervisor forwards url.pathname, while service.ts keys session identity on the raw path, so the two must agree:
  // a raw path that reaches a route only through dot segments (`/session/ses_A/../ses_B/prompt_async`) is refused.
  if (command.path.split("?")[0] !== path) return invalid()
  const session = "ses_[A-Za-z0-9]{1,80}"
  const request = "(?:per|req|que)_[A-Za-z0-9]{1,80}"
  // A Connect.RunID (schema connect.ts), narrower than the desktop's Remote rule (`cr_[A-Za-z0-9_-]{1,61}`):
  // RunID.create() appends ascending()'s letters and digits only (schema identifier.ts), and protocol.test.ts pins
  // that its ids pass.
  const run = "cr_[A-Za-z0-9]{1,61}"
  // Connected tools (CW-24b): a conversation's members and runs, one run, its cancel, and one VectorScope review of
  // uncommitted, staged or branch changes, always in the background. service.ts forwards the body as sent, so it is
  // exactly the engine's review input (schema Connect.ReviewInput, which has no `action`). Fixes, findings, dismissals,
  // the sessionless folder review and every other /experimental route stay refused, and so does a path that reaches
  // one of these routes only through dot segments (refused above for every route).
  if (path.startsWith("/experimental/")) {
    if (command.method === "GET" && (path === "/experimental/connect" || path === "/experimental/connect/runs")) {
      const keys = [...url.searchParams.keys()]
      if (
        command.body !== undefined ||
        keys.length !== 1 ||
        keys[0] !== "sessionID" ||
        !new RegExp(`^${session}$`).test(url.searchParams.get("sessionID") ?? "")
      )
        return invalid()
      return
    }
    if (url.search) return invalid()
    if (command.method === "GET" && new RegExp(`^/experimental/connect/runs/${run}$`).test(path)) {
      if (command.body !== undefined) return invalid()
      return
    }
    if (command.method === "POST" && new RegExp(`^/experimental/connect/runs/${run}/cancel$`).test(path)) {
      if (command.body !== undefined && (!record(command.body) || Object.keys(command.body).length)) return invalid()
      return
    }
    if (command.method !== "POST" || !new RegExp(`^/experimental/session/${session}/connect$`).test(path))
      return invalid()
    const body = command.body
    if (!record(body)) return invalid()
    fields(body, ["to", "target", "background"])
    const target = body.target
    if (
      body.to !== "vectorscope" ||
      body.background !== true ||
      !record(target) ||
      (target.kind !== "uncommitted" && target.kind !== "staged" && target.kind !== "branch")
    )
      return invalid()
    fields(target, target.kind === "branch" ? ["kind", "base"] : ["kind"])
    // A branch review's base, as Connect.Ref (schema connect.ts), which the desktop's and the phone's Remote copies
    // also mirror: never an option, no space or control character. protocol.test.ts checks it against Connect.Ref.
    if (
      target.base !== undefined &&
      (typeof target.base !== "string" || !/^(?!-)[^\s\u0000-\u001f\u007f]{1,256}$/.test(target.base))
    )
      return invalid()
    return
  }
  if ([...url.searchParams.keys()].some((key) => !["limit", "roots"].includes(key))) return invalid()
  if (url.search && path !== "/session" && !new RegExp(`^/session/${session}/message$`).test(path)) return invalid()
  if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) return invalid()
  const limit = url.searchParams.get("limit")
  if (limit !== null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100)) return invalid()
  if (url.searchParams.has("roots") && url.searchParams.get("roots") !== "true") return invalid()
  if (command.method === "GET") {
    if (command.body !== undefined) return invalid()
    if (
      ["/session", "/session/status", "/provider", "/permission", "/question"].includes(path) ||
      new RegExp(`^/session/${session}(?:/message)?$`).test(path)
    )
      return
    return invalid()
  }
  if (url.search) return invalid()
  if (path === "/session") {
    const body = command.body ?? {}
    if (!record(body)) return invalid()
    fields(body, ["title", "model"])
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 100)) return invalid()
    if (body.model !== undefined) validateModel(body.model)
    return
  }
  if (new RegExp(`^/session/${session}/abort$`).test(path)) {
    if (command.body !== undefined && (!record(command.body) || Object.keys(command.body).length)) return invalid()
    return
  }
  if (new RegExp(`^/session/${session}/message_id$`).test(path)) {
    if (!record(command.body)) return invalid()
    fields(command.body, ["requestID"])
    if (!workspaceId(command.body.requestID)) return invalid()
    return
  }
  if (new RegExp(`^/session/${session}/prompt_async$`).test(path)) {
    const body = command.body
    if (!record(body)) return invalid()
    fields(body, ["messageID", "parts", "model"])
    if (
      typeof body.messageID !== "string" ||
      !/^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/.test(body.messageID) ||
      !Array.isArray(body.parts) ||
      body.parts.length !== 1 ||
      !record(body.parts[0])
    )
      return invalid()
    const part = body.parts[0]
    fields(part, ["type", "text"])
    if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim() || part.text.length > 100_000)
      return invalid()
    if (body.model !== undefined) validateModel(body.model)
    return
  }
  if (new RegExp(`^/permission/${request}/reply$`).test(path)) {
    if (!record(command.body)) return invalid()
    fields(command.body, ["reply", "confirm"])
    if (command.body.reply !== "once" && command.body.reply !== "reject") return invalid()
    if (Object.hasOwn(command.body, "confirm") && (command.body.reply !== "once" || command.body.confirm !== true))
      return invalid()
    return
  }
  if (new RegExp(`^/question/${request}/reject$`).test(path)) {
    if (command.body !== undefined && (!record(command.body) || Object.keys(command.body).length)) return invalid()
    return
  }
  if (new RegExp(`^/question/${request}/reply$`).test(path)) {
    if (!record(command.body)) return invalid()
    fields(command.body, ["answers"])
    if (
      !Array.isArray(command.body.answers) ||
      command.body.answers.length > 10 ||
      command.body.answers.some(
        (answer) =>
          !Array.isArray(answer) ||
          answer.length > 10 ||
          answer.some((text) => typeof text !== "string" || text.length > 4000),
      )
    )
      return invalid()
    return
  }
  return invalid()
}

function validateModel(value: unknown) {
  if (!record(value)) return invalid()
  fields(value, ["providerID", "modelID"])
  if (
    value.providerID !== "vector-cloud" ||
    typeof value.modelID !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,150}$/.test(value.modelID)
  )
    return invalid()
}

function invalid(): never {
  throw new WorkspaceError("INVALID_WORKSPACE_REQUEST", "The workspace request contains unsupported or invalid fields.")
}
