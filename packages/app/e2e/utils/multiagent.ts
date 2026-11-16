import { base64Encode } from "@vectordevai/core/util/encode"
import type { Task } from "@vectordevai/schema/task"
import { expect, type Locator, type Page } from "@playwright/test"
import { mockVectorServer, type MockServerConfig } from "./mock-server"
import { installSseTransport } from "./sse-transport"
import { expectSessionTitle } from "./waits"

/*
 * The multi-agent specs (WP40b) share one conversation: a root session in one project, its subagents as Background
 * tasks rows, and an engine whose capability flags, task routes and workflow routes each spec sets. Events go through a
 * live SSE stream, so a spec can change a session's status or stream a child's parts the way the engine does.
 */

export const host = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
export const port = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
export const server = `http://${host}:${port}`
export const directory = "C:/Vector/MultiAgent"
export const projectID = "proj_multiagent"
export const rootID = "ses_multiagent_root"
export const rootTitle = "Ship the parser rewrite"
export const CREATED = 1700000000000

export type Session = { id: string } & Record<string, unknown>
export type Envelope = { directory: string; payload: { type: string; properties: unknown } }
export type Status = Record<string, { type: string }>

export function session(id: string, title: string, extra: Record<string, unknown> = {}): Session {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: CREATED, updated: CREATED },
    ...extra,
  }
}

/** A subagent's own session under the root. */
export function child(id: string, title: string, extra: Record<string, unknown> = {}) {
  return session(id, title, { parentID: rootID, ...extra })
}

export const model = { providerID: "anthropic", modelID: "maker/text" }

/** One connected model, so the composer can send. */
export function provider() {
  return {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        source: "api",
        models: {
          "maker/text": {
            id: "maker/text",
            name: "Maker Text",
            providerID: "anthropic",
            limit: { context: 128000, output: 8000 },
            cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
            variants: {},
            capabilities: { toolcall: true, input: { text: true, image: false }, output: { text: true } },
            modalities: { input: ["text"], output: ["text"] },
            tool_call: true,
          },
        },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "maker/text" },
  }
}

export function userMessage(sessionID: string, id: string, text: string, created = CREATED) {
  return {
    info: { id, sessionID, role: "user", time: { created }, agent: "build", model },
    parts: [{ id: `prt_${id}_text`, sessionID, messageID: id, type: "text", text }],
  }
}

export function assistantInfo(
  sessionID: string,
  id: string,
  parentID: string,
  extra: { completed?: boolean; error?: unknown; created?: number } = {},
) {
  const created = extra.created ?? CREATED + 1_000
  return {
    id,
    sessionID,
    role: "assistant",
    time: extra.completed === false ? { created } : { created, completed: created + 1_000 },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0.01,
    tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(extra.error ? { error: extra.error } : {}),
  }
}

export function assistantMessage(
  sessionID: string,
  id: string,
  parentID: string,
  parts: Record<string, unknown>[],
  extra: { completed?: boolean; error?: unknown; created?: number } = {},
) {
  return {
    info: assistantInfo(sessionID, id, parentID, extra),
    parts: parts.map((part) => ({ ...part, sessionID, messageID: id })),
  }
}

/** A Background tasks row as `GET …/tasks` sends it. Its ID is its session's, as for the engine's own subagents. */
export function task(input: { id: string; title: string } & Partial<Task.Info>): Task.Info {
  const status = input.status ?? "running"
  const live = status === "queued" || status === "running" || status === "waiting_on_user"
  const startedAt = input.startedAt ?? Date.now() - 60_000
  return {
    sessionID: input.id,
    parentSessionID: rootID,
    source: "subagent",
    agent: "general",
    status,
    startedAt,
    ...(live ? {} : { completedAt: startedAt + 30_000 }),
    elapsedMs: live ? 60_000 : 30_000,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: !live,
    attempt: 1,
    background: true,
    ...input,
    controls: { inspect: true, message: live, stop: live, ...input.controls },
  }
}

export type Setup = {
  /** Sessions besides the root: its subagents and workflow runs. */
  sessions?: Session[]
  /** Sessions the `/session` list leaves out (a child the engine has not announced yet). */
  unlisted?: string[]
  messages?: Record<string, unknown[]>
  /** `GET /session/status`; a function is read on every request. */
  status?: Status | (() => Status)
  /** Settings → General values, over the new layout. */
  settings?: Record<string, unknown>
} & Pick<
  MockServerConfig,
  "capabilities" | "taskList" | "taskRoute" | "workflow" | "globalConfig" | "permissions" | "questions"
>

export function sessionHref(sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

/** Mocks the engine, installs the live event stream and the page's storage. Nothing is opened yet. */
export async function setup(page: Page, input: Setup = {}) {
  const sessions = [session(rootID, rootTitle), ...(input.sessions ?? [])]
  const events = await installSseTransport<Envelope>(page, { server, path: "/global/event", retry: 20 })
  const capture = await mockVectorServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "multiagent",
      time: { created: CREATED, updated: CREATED },
      sandboxes: [],
    },
    provider: provider(),
    sessions,
    pageMessages: (sessionID) => ({ items: input.messages?.[sessionID] ?? [] }),
    sessionStatus: input.status ?? {},
    capabilities: input.capabilities,
    taskList: input.taskList,
    taskRoute: input.taskRoute,
    workflow: input.workflow,
    globalConfig: input.globalConfig,
    permissions: input.permissions,
    questions: input.questions,
  })
  // Wide enough for the docked layout, the session header's tools and the Background tasks pane.
  await page.setViewportSize({ width: 1440, height: 900 })
  const unlisted = new Set(input.unlisted ?? [])
  if (unlisted.size)
    await page.route(
      (url) => url.pathname === "/session" && url.port === port,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(sessions.filter((item) => !unlisted.has(item.id))),
        }),
    )
  await page.addInitScript(
    ({ directory, server, rootID, settings }) => {
      // The built App uses its saved server selection; the fixture engine lives on this exact origin.
      localStorage.setItem("vector.settings.dat:defaultServerUrl", server)
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, ...settings } }))
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          list: [server],
          projects: {
            local: [{ worktree: directory, expanded: true }],
            [server]: [{ worktree: directory, expanded: true }],
          },
          lastProject: { local: directory, [server]: directory },
        }),
      )
      localStorage.setItem(
        "vector.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: rootID }]),
      )
    },
    { directory, server, rootID, settings: input.settings ?? {} },
  )

  return {
    capture,
    /**
     * Opens a session's page and waits for its title, the event stream and, when the spec set them, the engine's
     * capability flags: every control reads them when it is used.
     */
    async open(sessionID = rootID, title = rootTitle) {
      const flags =
        input.capabilities === undefined
          ? undefined
          : page.waitForResponse((response) => new URL(response.url()).pathname === "/experimental/capabilities")
      await page.goto(sessionHref(sessionID))
      await events.waitForConnection()
      await expectSessionTitle(page, title)
      await flags
    },
    /** Sends one engine event on the live stream, addressed to a location (the root's folder by default). */
    send(type: string, properties: unknown, location = directory) {
      return events.send({ directory: location, payload: { type, properties } })
    },
  }
}

/** The posts of one kind the mock answered, by path. */
export function posts(list: { method: string; path: string; body: unknown }[], path: string | RegExp) {
  return list.filter(
    (item) => item.method !== "GET" && (typeof path === "string" ? item.path === path : path.test(item.path)),
  )
}

export function composer(page: Page) {
  return page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
}

export function submitButton(page: Page) {
  return page.locator('[data-action="prompt-submit"]').filter({ visible: true }).first()
}

/** A toast, in either layout's toast region. */
export function toast(page: Page, text: string | RegExp) {
  return page.locator('[data-component="toast"], [data-component="toast-v2"]').filter({ hasText: text })
}

/** Opens Background tasks from the session header. */
export async function openTasks(page: Page) {
  const panel = page.getByRole("complementary", { name: "Background tasks", exact: true })
  if (!(await panel.isVisible())) await page.locator("[data-vector-bg-tasks-launch]").first().click()
  await expect(panel).toBeVisible()
  return panel
}

/** A card in the pane, by its title. */
export function card(panel: Locator, title: string) {
  return panel.locator("article.vector-bg-tasks-card").filter({
    has: panel.page().locator(".vector-bg-tasks-card-title, .vector-bg-tasks-card-heading", { hasText: title }),
  })
}

/** Opens a finished card and its first phase, so its agents' details show. */
export async function openFinished(panel: Locator, title: string) {
  const finished = panel.getByRole("button", { name: /^Finished \d+$/ })
  if ((await finished.getAttribute("aria-expanded")) !== "true") await finished.click()
  const item = card(panel, title)
  const toggle = item.locator(".vector-bg-tasks-card-toggle")
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  const phase = item.locator(".vector-bg-tasks-phase-toggle").first()
  if ((await phase.getAttribute("aria-expanded")) !== "true") await phase.click()
  return item
}
