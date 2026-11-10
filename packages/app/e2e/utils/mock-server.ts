import type { Page, Route } from "@playwright/test"

const emptyList = new Set(["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff"])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp"])

const REPLY = Symbol("mock reply")

/** An answer with its own status and content type: a 403, a 404, an engine error, an HTML page. */
export type MockReply = { [REPLY]: true; status: number; body?: unknown; contentType?: string }

export function reply(status: number, body?: unknown, contentType = "application/json"): MockReply {
  return { [REPLY]: true, status, body, contentType }
}

function isReply(value: unknown): value is MockReply {
  return !!value && typeof value === "object" && REPLY in value
}

/** A request the mock answered, as the app sent it. */
export type MockRequest = { method: string; path: string; query: URLSearchParams; body: unknown }

/** Task routes under `/experimental/session/:sessionID` other than the board itself (`GET …/tasks`). */
export type TaskRouteRequest = MockRequest & {
  sessionID: string
  /** The task the path names: inspect, changes, message, merge, discard. */
  taskID?: string
  action:
    | "session.stop"
    | "session.background"
    | "stop"
    | "wait"
    | "resume"
    | "background"
    | "inspect"
    | "changes"
    | "message"
    | "merge"
    | "discard"
}

/** Workflow routes 7 to 12. */
export type WorkflowRouteRequest = MockRequest & {
  action: "saved" | "validate" | "start" | "list" | "get" | "resume"
  sessionID?: string
  runID?: string
}

/** What the app sent, for specs to read back. Only requests the mock itself answers are recorded. */
export type MockCapture = {
  /** Bodies of `PATCH /global/config`, in order. */
  config: unknown[]
  /** Posts to route 1, the old background route and the task routes under `/experimental/session/:id`. */
  tasks: MockRequest[]
  /** Posts to the workflow routes. */
  workflow: MockRequest[]
  /** Posts to `/session/:id/…`: abort, prompt_async, shell, command, permission replies. */
  session: MockRequest[]
}

export interface MockServerConfig {
  baseURL?: string
  serverPort?: string
  onRequest?: (url: URL) => void
  provider: unknown
  agents?: unknown[]
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  vcsDiff?: unknown[]
  vcsStatus?: unknown[] | (() => unknown[])
  messageDelay?: number
  onMessages?: (input: { sessionID: string; before?: string; phase: "start" | "end" }) => void
  /** Global stream envelopes containing directory and payload. */
  events?: () => unknown[]
  /** Connection-scoped directory events, such as unwrapped presence payloads. */
  directoryEvents?: () => unknown[]
  eventRetry?: number
  todos?: (sessionID: string) => unknown[]
  permissions?: unknown[] | (() => unknown[])
  questions?: unknown[] | (() => unknown[])
  fileList?: (path: string) => unknown | Promise<unknown>
  fileContent?: (path: string) => unknown | Promise<unknown>
  sessionStatus?: unknown | (() => unknown)
  /**
   * `GET /experimental/capabilities`: engine flags (including nested computer capabilities), or a custom reply.
   * Omitted models an older engine without the capabilities route and answers 404.
   */
  capabilities?: Record<string, unknown> | MockReply | (() => Record<string, unknown> | MockReply)
  /** The directory's effective config (`GET /config`); omitted answers an empty object. */
  directoryConfig?: unknown
  /** MCP server statuses by name (`GET /mcp`); omitted answers an empty object. */
  mcpStatus?: unknown
  /** `GET /experimental/session/:sessionID/tasks`: the root's board, or a workflow run's agents (sessionID = runID). */
  taskList?: (input: { sessionID: string; query: URLSearchParams }) => unknown
  /** Every other task route. Undefined answers as an unconfigured mock does (`{}`). */
  taskRoute?: (request: TaskRouteRequest) => unknown
  /** The workflow routes (saved, validate, start, list, get, resume). Undefined answers `{}`. */
  workflow?: (request: WorkflowRouteRequest) => unknown
  /** The engine's global config. Set, `GET /global/config` answers it and a PATCH deep-merges into it. */
  globalConfig?: Record<string, unknown>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The global config update deep-merges objects and replaces everything else, as the engine's does. */
function mergeConfig(base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  const next = { ...base }
  for (const [key, value] of Object.entries(record(patch) ?? {})) {
    const current = record(next[key])
    next[key] = current && record(value) ? mergeConfig(current, value) : value
  }
  return next
}

function taskAction(
  method: string,
  rest: string[],
): { action: TaskRouteRequest["action"]; taskID?: string } | "list" | undefined {
  // rest is what follows /experimental/session/:sessionID
  if (method === "POST" && rest.length === 1 && rest[0] === "stop") return { action: "session.stop" }
  if (method === "POST" && rest.length === 1 && rest[0] === "background") return { action: "session.background" }
  if (rest[0] !== "tasks") return undefined
  if (rest.length === 1) return method === "GET" ? "list" : undefined
  if (rest.length === 2) {
    const name = rest[1]!
    if (method === "POST" && (name === "stop" || name === "wait" || name === "resume" || name === "background"))
      return { action: name }
    if (method === "GET") return { action: "inspect", taskID: name }
    return undefined
  }
  if (rest.length === 3) {
    const [, taskID, name] = rest
    if (method === "GET" && name === "changes") return { action: "changes", taskID }
    if (method === "POST" && (name === "message" || name === "merge" || name === "discard"))
      return { action: name, taskID }
  }
  return undefined
}

function workflowAction(
  method: string,
  segments: string[],
): Pick<WorkflowRouteRequest, "action" | "sessionID" | "runID"> | undefined {
  // /experimental/workflow/(saved|validate)
  if (segments[1] === "workflow") {
    if (method === "GET" && segments[2] === "saved" && segments.length === 3) return { action: "saved" }
    if (method === "POST" && segments[2] === "validate" && segments.length === 3) return { action: "validate" }
    return undefined
  }
  // /experimental/session/:sessionID/workflow(/:runID(/resume)?)?
  if (segments[1] !== "session" || segments[3] !== "workflow") return undefined
  const sessionID = segments[2]!
  if (segments.length === 4) return method === "POST" ? { action: "start", sessionID } : { action: "list", sessionID }
  if (segments.length === 5 && method === "GET") return { action: "get", sessionID, runID: segments[4] }
  if (segments.length === 6 && segments[5] === "resume" && method === "POST")
    return { action: "resume", sessionID, runID: segments[4] }
  return undefined
}

export async function mockVectorServer(page: Page, config: MockServerConfig): Promise<MockCapture> {
  const cursors = new Map<string, string>()
  let nextCursor = 0
  let globalConfig = config.globalConfig
  const capture: MockCapture = { config: [], tasks: [], workflow: [], session: [] }
  const staticRoutes: Record<string, unknown> = {
    "/provider": config.provider,
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/Vector",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": config.agents ?? [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions,
  }
  const targetPort = config.serverPort ?? process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
  const appURL = new URL(
    config.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
  )
  const paths = [
    ...emptyList,
    ...emptyObject,
    ...Object.keys(staticRoutes),
    "/global/event",
    "/global/health",
    "/event",
    "/permission",
    "/question",
    "/session/status",
    "/experimental/capabilities",
    "/file",
    "/file/content",
    "/pty",
    // The multi-agent routes. Unconfigured, they fall through as before.
    "/experimental/[^?]+",
    "/session/[^/?]+/(?:abort|prompt_async|shell|command|permissions/[^/?]+)",
  ]
  // A serializable matcher lets Playwright bypass the test worker for Vite's asset graph.
  // URL predicates and catchalls would dispatch hundreds of unnecessary route/fallback RPCs.
  const pattern = new RegExp(
    `${targetPort !== appURL.port ? `^https?://[^/]+:${targetPort}/|` : ""}^${appURL.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:${paths.join("|")}|/session/[^/?]+(?:/(?:children|diff|message|todo))?)(?:\\?|$)`,
  )
  await page.route(pattern, async (route) => {
    const url = new URL(route.request().url())
    config.onRequest?.(url)

    const path = url.pathname
    const method = route.request().method()
    const request = (): MockRequest => {
      let body: unknown
      try {
        body = method === "GET" || method === "HEAD" ? undefined : route.request().postDataJSON()
      } catch {
        body = route.request().postData()
      }
      return { method, path, query: url.searchParams, body }
    }
    const answer = (value: unknown) =>
      isReply(value)
        ? route.fulfill({
            status: value.status,
            contentType: value.contentType,
            headers: { "access-control-allow-origin": "*" },
            body:
              value.body === undefined ? "" : typeof value.body === "string" ? value.body : JSON.stringify(value.body),
          })
        : json(route, value)

    if (method !== "GET" && method !== "HEAD" && /^\/session\/[^/]+\/./.test(path)) capture.session.push(request())

    if (path === "/global/config" && globalConfig) {
      if (method === "PATCH") {
        const sent = request()
        capture.config.push(sent.body)
        globalConfig = mergeConfig(globalConfig, sent.body)
      }
      return json(route, globalConfig)
    }
    if (path === "/global/config" && method === "PATCH") capture.config.push(request().body)

    if (path.startsWith("/experimental/")) {
      const segments = path.slice(1).split("/")
      const flow = workflowAction(method, segments)
      if (flow) {
        const sent = request()
        if (method !== "GET") capture.workflow.push(sent)
        const result = config.workflow?.({ ...sent, ...flow })
        if (result !== undefined) return answer(result)
      } else if (segments[1] === "capabilities" && segments.length === 2) {
        const flags = typeof config.capabilities === "function" ? config.capabilities() : config.capabilities
        return flags === undefined ? json(route, { error: "Not found" }, undefined, 404) : answer(flags)
      } else if (segments[1] === "session" && segments.length >= 4) {
        const sessionID = segments[2]!
        const action = taskAction(method, segments.slice(3))
        const sent = request()
        if (method !== "GET") capture.tasks.push(sent)
        if (action === "list") {
          const result = config.taskList?.({ sessionID, query: url.searchParams })
          if (result !== undefined) return answer(result)
        } else if (action) {
          const result = config.taskRoute?.({ ...sent, sessionID, ...action })
          if (result !== undefined) return answer(result)
        }
      }
    }

    if (path === "/global/event") return sse(route, config.events?.(), config.eventRetry)
    if (path === "/event") return sse(route, config.directoryEvents?.(), config.eventRetry)
    if (path === "/global/health") return json(route, { healthy: true })
    if (path === "/permission")
      return json(route, typeof config.permissions === "function" ? config.permissions() : (config.permissions ?? []))
    if (path === "/question")
      return json(route, typeof config.questions === "function" ? config.questions() : (config.questions ?? []))
    if (path === "/session/status")
      return json(
        route,
        (typeof config.sessionStatus === "function" ? config.sessionStatus() : config.sessionStatus) ?? {},
      )
    if (path === "/vcs/diff" && config.vcsDiff) return json(route, config.vcsDiff)
    if (path === "/vcs/status" && config.vcsStatus)
      return json(route, typeof config.vcsStatus === "function" ? config.vcsStatus() : config.vcsStatus)
    if (path === "/file" && config.fileList)
      return json(route, await config.fileList(url.searchParams.get("path") ?? ""))
    if (path === "/file/content" && config.fileContent)
      return json(route, await config.fileContent(url.searchParams.get("path") ?? ""))
    if (path === "/config" && config.directoryConfig !== undefined) return json(route, config.directoryConfig)
    if (path === "/mcp" && config.mcpStatus !== undefined) return json(route, config.mcpStatus)
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    const todoMatch = path.match(/^\/session\/([^/]+)\/todo$/)
    if (todoMatch) return json(route, config.todos?.(todoMatch[1]!) ?? [])
    if (/^\/session\/[^/]+\/(children|diff)$/.test(path)) return json(route, [])
    // The location's terminals, which the server lists as an array: none here. A spec that opens one answers its own
    // /pty routes, ahead of these.
    if (path === "/pty" && route.request().method() === "GET") return json(route, [])

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const token = url.searchParams.get("before") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "start" })
      if (config.messageDelay) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "end" })
      if (!pageData.cursor) return json(route, pageData.items)
      const cursor = `cursor_${++nextCursor}`
      cursors.set(cursor, pageData.cursor)
      return json(route, pageData.items, { "x-next-cursor": cursor })
    }

    if (url.port === targetPort && targetPort !== appURL.port) return json(route, {})
    return route.fallback()
  })
  return capture
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[], retry?: number) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `${retry === undefined ? "" : `retry: ${retry}\n\n`}${events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n"}`,
  })
}
