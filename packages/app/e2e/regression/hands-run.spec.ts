import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { Hands } from "@vectordevai/schema/hands"
import type { Computer } from "@vectordevai/schema/computer"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import { toolPart } from "../performance/timeline-stability/fixture"
import { calls, installFakeComputer, pushState } from "../utils/fake-computer"
import { mockVectorServer, type MockServerConfig } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// The Tasks card, the Tasks button's dot and the composer's working line, driven by desktop state the test pushes
// through the fake platform. Commands only record intent; the test pushes the state the desktop would publish next.
// The engine cases install no fake desktop, so the page follows the engine's computer.state event instead.

const directory = "C:/Vector/ComputerRun"
const otherDirectory = "C:/Vector/OtherRun"
const sessionID = "ses_computer_run"
const title = "Computer run fixture"
const holderID = "ses_computer_holder"
const holderTitle = "Quarterly receipts"
const appKey = "app:macos:com.apple.iwork.numbers"

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: { sessionID, directory, title, startedAt: Date.now(), actions: 4 },
    apps: [{ key: appKey, name: "Numbers" }],
    step: "Clicking “Save” in Numbers",
    queue: [],
    escStops: true,
    stopChord: "⌘⇧Esc",
    lease: 1,
    reduceMotion: false,
    ...patch,
  }
}

const appAsk: PermissionRequest = {
  id: "perm_computer_run_app",
  sessionID,
  permission: "computer_app",
  patterns: [appKey],
  always: [appKey],
  metadata: {
    action: "use_app",
    level: "interact",
    target: {
      appName: "Numbers",
      appKey,
      platform: "macos",
      publisher: "Apple Inc.",
      verified: true,
      category: "office",
    },
    canAlways: true,
  },
}

test("a working state shows the Tasks dot, the pinned card and the composer's app", async ({ page }) => {
  const fixture = await openRun(page)
  await expect(fixture.dot).toHaveCount(0)
  await pushState(page, state())
  await expect(fixture.dot).toBeVisible()
  await expect(fixture.launch).toHaveAttribute("aria-label", new RegExp(`${Hands.NAME} is working`))
  await expect(fixture.status).toContainText("Using Numbers")
  await fixture.launch.click()
  await expect(fixture.card).toBeVisible()
  await expect(fixture.card).toContainText("Working")
  await expect(fixture.card).toContainText("Clicking “Save” in Numbers")
  await expect(fixture.card).toContainText("4 actions")
  await expect(page.locator("#vector-bg-tasks")).not.toContainText("No background tasks")

  await pushState(page, state({ phase: "done" }))
  await expect(fixture.card).toContainText("Done")
  await expect(fixture.dot).toHaveCount(0)
  await expect(fixture.card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
})

test("Stop on the Tasks card sends stop", async ({ page }) => {
  const fixture = await openRun(page)
  await pushState(page, state())
  await fixture.launch.click()
  await fixture.card.getByRole("button", { name: "Stop", exact: true }).click()
  await expect.poll(() => calls(page)).toEqual([{ method: "command", command: "stop" }])
  // The desktop stops input first and aborts the turn itself (INV-R1); the page sends no abort of its own.
  expect(fixture.aborts).toEqual([])
})

test("Take over and Resume swap with the run's phase", async ({ page }) => {
  const fixture = await openRun(page)
  await pushState(page, state())
  await fixture.launch.click()
  await expect(fixture.card.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0)
  await fixture.card.getByRole("button", { name: "Take over", exact: true }).click()
  await expect.poll(() => calls(page)).toEqual([{ method: "command", command: "takeover" }])

  await pushState(page, state({ phase: "paused", pause: "input", escStops: false }))
  await expect(fixture.card).toContainText("Paused — you have control")
  await expect(fixture.launch).toHaveAttribute("aria-label", new RegExp(`${Hands.NAME} is paused$`))
  await expect(fixture.card.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0)
  await fixture.card.getByRole("button", { name: "Resume", exact: true }).click()
  await expect
    .poll(() => calls(page))
    .toEqual([
      { method: "command", command: "takeover" },
      { method: "command", command: "resume" },
    ])
})

test("a queued state waits for the other conversation and stops only its own call", async ({ page }) => {
  const fixture = await openRun(page)
  await pushState(
    page,
    state({
      holder: { sessionID: holderID, directory, title: holderTitle, startedAt: Date.now(), actions: 9 },
      queue: [{ sessionID, title }],
    }),
  )
  await expect(fixture.status).toContainText("Waiting for the computer")
  await expect(fixture.dot).toHaveCount(0)
  await fixture.launch.click()
  await expect(fixture.queued).toContainText(`Waiting for the computer: ${holderTitle} is using it`)
  await expect(fixture.queued.getByRole("button", { name: "Open that task", exact: true })).toBeVisible()
  await fixture.queued.getByRole("button", { name: "Stop", exact: true }).click()
  await expect.poll(() => calls(page)).toEqual([{ method: "command", command: "stop-session", arg: { sessionID } }])

  await fixture.queued.getByRole("button", { name: "Open that task", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(holderID))
})

test("an app ask is answered on the card once, after Allow arms", async ({ page }) => {
  const fixture = await openRun(page, { permissions: [appAsk] })
  await pushState(page, state())
  await fixture.launch.click()
  await expect(fixture.card).toBeVisible()
  // The ask arms from when the card shows it; hold the page clock from here.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  await pushState(
    page,
    state({
      phase: "asking",
      ask: {
        requestID: appAsk.id,
        directory,
        kind: "app",
        title: `Allow ${Hands.NAME} to use Numbers?`,
        canAlways: true,
        shownAt: Date.now(),
      },
    }),
  )
  const ask = fixture.card.locator(`[data-computer-ask="${appAsk.id}"]`)
  const allow = ask.getByRole("button", { name: "Allow", exact: true })
  await expect(ask.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0)
  await expect(allow).toBeDisabled()
  await page.clock.runFor(699)
  await allow.click({ force: true })
  expect(fixture.replies).toEqual([])
  await page.clock.runFor(1)
  await expect(allow).toBeEnabled()
  await allow.click()
  await expect.poll(() => fixture.replies.length).toBe(1)
  await allow.click({ force: true })
  expect(fixture.replies).toEqual([{ path: `/permission/${appAsk.id}/reply`, body: { reply: "once" } }])
  expect(await calls(page)).toEqual([])
})

test("a sensitive ask on the card only links to the conversation", async ({ page }) => {
  const fixture = await openRun(page)
  await fixture.launch.click()
  await pushState(
    page,
    state({
      phase: "asking",
      ask: {
        requestID: "perm_computer_run_sensitive",
        directory,
        kind: "sensitive",
        title: `${Hands.NAME} wants to click “Send” in Mail`,
        canAlways: false,
        shownAt: Date.now(),
      },
    }),
  )
  await expect(fixture.card).toContainText("Needs you")
  await expect(fixture.launch).toHaveAttribute("aria-label", new RegExp(`${Hands.NAME} needs you$`))
  await expect(fixture.card.getByRole("button", { name: "Review in the conversation", exact: true })).toBeVisible()
  await expect(fixture.card.getByRole("button", { name: /^Allow/ })).toHaveCount(0)
  await expect(fixture.card.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0)
})

test("the compact header keeps the Tasks dot", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  const fixture = await openRun(page)
  await pushState(page, state())
  await expect(fixture.dot).toBeVisible()
  await expect(fixture.launch).toHaveAttribute("aria-label", new RegExp(`${Hands.NAME} is working$`))
})

test("Watch opens the run live from the screenshot or the button", async ({ page }) => {
  const fixture = await openRun(page, { messages: runMessages() })
  await pushState(page, state())
  await fixture.launch.click()
  const thumb = fixture.card.locator(".vector-bg-tasks-computer-thumb")
  await expect(thumb.locator("img")).toHaveAttribute("src", PNG)
  const button = fixture.card.locator(".vector-bg-tasks-computer-actions").getByRole("button", { name: "Watch" })
  const dialog = page.getByRole("dialog").filter({ has: page.locator('[data-computer-card="holder"]') })
  for (const open of [thumb, button]) {
    await open.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-computer-card="holder"]')).toContainText("Working")
    const run = dialog.locator('[data-component="computer-run"]')
    await expect(run.locator('[data-slot="computer-run-step-label"]')).toHaveText([
      "Looked at Numbers",
      "Clicked “Save” in Numbers",
    ])
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  }
  // The dialog follows the desktop's state while it is open.
  await button.click()
  await pushState(page, state({ phase: "paused", pause: "input", escStops: false }))
  await expect(dialog.locator('[data-computer-card="holder"]')).toContainText("Paused — you have control")
  await expect(dialog.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
})

test("without the desktop, the engine's event shows the dot, the card and the app, and Stop aborts the turn", async ({
  page,
}) => {
  const engine = engineRun()
  const fixture = await openRun(page, { engine })
  await expect(fixture.dot).toHaveCount(0)
  engine.publish(state())
  await expect(fixture.dot).toBeVisible()
  await expect(fixture.launch).toHaveAttribute("aria-label", new RegExp(`${Hands.NAME} is working$`))
  await expect(fixture.status).toContainText("Using Numbers")
  await fixture.launch.click()
  await expect(fixture.card).toContainText("Working")
  await expect(fixture.card).toContainText("Clicking “Save” in Numbers")
  await expect(fixture.card.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0)

  // Take over and Resume need the desktop; Stop aborts the holder's turn through the session API.
  engine.publish(state({ phase: "paused", pause: "input", escStops: false }))
  await expect(fixture.card).toContainText("Paused — you have control")
  await expect(fixture.card.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0)
  await fixture.card.getByRole("button", { name: "Stop", exact: true }).click()
  await expect.poll(() => fixture.aborts).toEqual([`/session/${sessionID}/abort`])
})

test("without the desktop, a queued card names a holder in another directory whose status the page never saw", async ({
  page,
}) => {
  const engine = engineRun()
  const fixture = await openRun(page, { engine })
  // The holder's status is not in the page's session status, but this conversation, queued behind it, is busy.
  engine.publish(
    state({
      holder: { sessionID: holderID, directory: otherDirectory, title: holderTitle, startedAt: Date.now(), actions: 9 },
      queue: [{ sessionID, title }],
    }),
    otherDirectory,
  )
  await expect(fixture.status).toContainText("Waiting for the computer")
  await fixture.launch.click()
  await expect(fixture.queued).toContainText(`Waiting for the computer: ${holderTitle} is using it`)
  await expect(fixture.queued.getByRole("button", { name: "Open that task", exact: true })).toBeVisible()
  await expect(fixture.queued.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(fixture.dot).toHaveCount(0)
})

test("without the desktop, a holder in provider retry keeps its card and one seen going idle loses it", async ({
  page,
}) => {
  const engine = engineRun({ type: "retry", attempt: 1, message: "Provider overloaded", next: Date.now() + 60_000 })
  const fixture = await openRun(page, { engine })
  engine.publish(state())
  await expect(fixture.dot).toBeVisible()
  await fixture.launch.click()
  await expect(fixture.card).toContainText("Working")

  engine.status({ type: "idle" })
  await expect(fixture.card).toHaveCount(0)
  await expect(fixture.dot).toHaveCount(0)
  // The engine's last publish can arrive after the turn ended; repeated, it still cannot bring the card back.
  const served = engine.served()
  await expect.poll(() => engine.served()).toBeGreaterThan(served + 1)
  await expect(fixture.card).toHaveCount(0)
  await expect(fixture.dot).toHaveCount(0)
})

/**
 * The engine's side of a run without the fake desktop, as the real desktop before D22, Linux, web and Remote see it.
 * The engine publishes at least every 2 s while it holds the computer, so the latest state repeats on every reconnect
 * of the event stream, after any pending status change of this conversation.
 */
function engineRun(initial: unknown = { type: "busy" }) {
  const statuses: Record<string, unknown> = { [sessionID]: initial }
  const pending: unknown[] = []
  const latest: { value?: { directory: string; state: Computer.ComputerState } } = {}
  let served = 0
  return {
    statuses: () => statuses,
    served: () => served,
    events: () => {
      served++
      const current = latest.value
      const heartbeat = current
        ? [
            {
              directory: current.directory,
              payload: {
                type: "computer.state",
                properties: { sessionID: current.state.holder?.sessionID, state: current.state },
              },
            },
          ]
        : []
      return [...pending.splice(0), ...heartbeat]
    },
    publish: (next: Computer.ComputerState, from = directory) => {
      latest.value = { directory: from, state: next }
    },
    status: (value: unknown) => {
      statuses[sessionID] = value
      pending.push({ directory, payload: { type: "session.status", properties: { sessionID, status: value } } })
    },
  }
}

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

/** The holder's latest turn: a screenshot with its image, then a click, as two completed computer calls. */
function runMessages() {
  const userID = "msg_1000_computer_run_user"
  const assistantID = "msg_1001_computer_run_assistant"
  const numbers = { key: appKey, name: "Numbers" }
  const parts = [
    toolPart(
      "prt_computer_run_1",
      "computer",
      "completed",
      { action: "screenshot" },
      {
        metadata: { app: numbers, action: "screenshot" },
        attachments: [
          {
            id: "prt_computer_run_1_shot",
            sessionID,
            messageID: assistantID,
            type: "file",
            mime: "image/png",
            url: PNG,
          },
        ],
      },
    ),
    toolPart(
      "prt_computer_run_2",
      "computer",
      "completed",
      { action: "click" },
      { metadata: { app: numbers, action: "click", target: { role: "button", name: "Save" } } },
    ),
  ]
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "fixture/text" },
      },
      parts: [{ id: "prt_computer_run_user", sessionID, messageID: userID, type: "text", text: "Save the receipts." }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 1700000001000 },
        parentID: userID,
        modelID: "fixture/text",
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: parts.map((part) => ({ ...part, sessionID, messageID: assistantID })),
    },
  ]
}

async function openRun(
  page: Page,
  options: { permissions?: PermissionRequest[]; messages?: unknown[]; engine?: ReturnType<typeof engineRun> } = {},
) {
  const replies: { path: string; body: unknown }[] = []
  const aborts: string[] = []
  const engine = options.engine
  await page.clock.install()
  const server: MockServerConfig = {
    directory,
    project: { id: "project-computer-run", worktree: directory, vcs: "git", name: "Computer run" },
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "api",
          models: {
            "fixture/text": {
              id: "fixture/text",
              name: "Fixture Text",
              providerID: "anthropic",
              limit: { context: 128000, output: 8000 },
              cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
              variants: {},
              capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true } },
              modalities: { input: ["text", "image"], output: ["text"] },
              tool_call: true,
            },
          },
        },
      ],
      connected: ["anthropic"],
      default: { anthropic: "fixture/text" },
    },
    sessions: [
      { id: sessionID, title, directory, projectID: "project-computer-run", time: { created: 2, updated: 2 } },
      {
        id: holderID,
        title: holderTitle,
        directory,
        projectID: "project-computer-run",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: (id) => ({ items: id === sessionID ? (options.messages ?? []) : [] }),
    sessionStatus: { [sessionID]: { type: "busy" } },
    permissions: options.permissions ?? [],
    capabilities: { backgroundSubagents: false, computer: { available: true, protocol: 1 } },
    ...(engine ? { events: engine.events, eventRetry: 50 } : {}),
  }
  if (!engine) await installFakeComputer(page, { prefs: { enabled: true } }, server)
  if (engine) {
    await mockVectorServer(page, server)
    // A reconnecting stream may reread session status, so it follows the status events.
    await page.route(/\/session\/status(?:\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(engine.statuses()),
      }),
    )
  }
  await page.route(/\/session\/[^/]+\/abort(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    aborts.push(new URL(route.request().url()).pathname)
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
  await page.route(/\/permission\/[^/]+\/reply(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    replies.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
  }, directory)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const launch = page.locator("[data-vector-bg-tasks-launch]").filter({ visible: true }).first()
  await expect(launch).toBeVisible()
  return {
    replies,
    aborts,
    launch,
    dot: launch.locator("[data-computer-dot]"),
    card: page.locator('#vector-bg-tasks [data-computer-card="holder"]'),
    queued: page.locator('#vector-bg-tasks [data-computer-card="queued"]'),
    status: page.locator('[data-component="session-composer-region"] [role="status"]'),
  }
}
