import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { Hands } from "@vectordevai/schema/hands"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import { calls, installFakeComputer } from "../utils/fake-computer"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/ComputerAsks"
const sessionID = "ses_computer_asks"
const title = "Computer approval fixture"
const appKey = "app:macos:com.apple.notes"
const dockSelector = '[data-component="dock-prompt"][data-kind="permission"]'
const appAsk: PermissionRequest = {
  id: "perm_computer_app",
  sessionID,
  permission: "computer_app",
  patterns: [appKey],
  always: [appKey],
  metadata: {
    action: "use_app",
    level: "interact",
    target: {
      appName: "Notes",
      appKey,
      platform: "macos",
      publisher: "Apple Inc.",
      teamId: "APPLE12345",
      verified: true,
      category: "office",
    },
    canAlways: true,
    mentioned: true,
    reason: "Organize the notes you selected",
  },
}

test("an app ask preserves composer focus and arms one explicit approval after 700 ms", async ({ page }) => {
  const fixture = await openAsk(page, appAsk)
  const dock = fixture.dock
  const allow = dock.getByRole("button", { name: "Allow", exact: true })
  const always = dock.getByRole("button", { name: "Always allow", exact: true })
  await expect(dock.getByRole("heading", { name: `Allow ${Hands.NAME} to use Notes?`, exact: true })).toBeVisible()
  await expect(dock.getByText("From Apple Inc.", { exact: true })).toBeVisible()
  await expect(dock.getByText("You mentioned Notes in your message.", { exact: true })).toBeVisible()
  await expect(dock.getByText("The agent says: “Organize the notes you selected”", { exact: true })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Deny", exact: true })).toBeEnabled()
  await expect(always).toBeVisible()
  await expect(dock).not.toContainText(appKey)

  await expect(fixture.composer).toBeFocused()
  await page.keyboard.type("hello")
  await expect(fixture.composer).toContainText("hello")
  await page.keyboard.press("Enter")
  await expect(dock).toBeVisible()
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText("hello")
  expect(fixture.prompts).toEqual([])
  expect(fixture.replies).toEqual([])

  await fixture.advanceTo(699)
  await expect(allow).toBeDisabled()
  await expect(always).toBeDisabled()
  // A forced pointer click bypasses Playwright's enabled wait, not the browser's disabled-button behavior.
  await allow.click({ force: true })
  expect(fixture.replies).toEqual([])
  await expect(dock).toBeVisible()

  await fixture.advanceTo(700)
  await expect(allow).toBeEnabled()
  await expect(always).toBeEnabled()
  try {
    await allow.click()
    await expect.poll(() => fixture.replies.length).toBe(1)
    await expect(allow).toBeDisabled()
    await allow.click({ force: true })
    expect(fixture.replies).toEqual([{ path: `/permission/${appAsk.id}/reply`, body: { reply: "once" } }])
  } finally {
    await fixture.finishReply()
  }
  expect(await calls(page)).toEqual([])
})

test("Plan mode queues composer text while a computer ask stays open", async ({ page }) => {
  const fixture = await openAsk(page, appAsk, { plan: true })
  await expect(page.locator('[data-action="prompt-mode"]')).toHaveText("Plan")
  await expect(fixture.composer).toBeFocused()
  await page.keyboard.type("hello")
  await expect(fixture.composer).toContainText("hello")
  await page.keyboard.press("Enter")
  await expect(fixture.dock).toBeVisible()
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText("hello")
  await expect(page.locator('[data-action="prompt-mode"]')).toHaveText("Plan")
  expect(fixture.prompts).toEqual([])
  expect(fixture.replies).toEqual([])
  expect(await calls(page)).toEqual([])
})

test("a browser ask explains why Always allow is unavailable", async ({ page }) => {
  const key = "app:macos:com.apple.safari"
  const fixture = await openAsk(page, {
    ...appAsk,
    id: "perm_computer_browser",
    patterns: [key],
    // Even a nonempty server always list must not expose saved consent for this category.
    always: [key],
    metadata: {
      ...appAsk.metadata,
      target: {
        ...(appAsk.metadata.target as Record<string, unknown>),
        appName: "Safari",
        appKey: key,
        category: "browser",
      },
      canAlways: false,
      alwaysWhyNot: "category",
      mentioned: false,
    },
  })
  await expect(fixture.dock.getByRole("heading", { name: `Allow ${Hands.NAME} to use Safari?` })).toBeVisible()
  await expect(fixture.dock.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0)
  await expect(
    fixture.dock.getByText(`${Hands.NAME} always asks for browsers, file managers, finance apps and developer tools.`, {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    fixture.dock.getByText(
      `${Hands.NAME} acts as you on sites where you're signed in. For websites, Vector's own browser is safer.`,
      { exact: true },
    ),
  ).toBeVisible()
  expect(fixture.replies).toEqual([])
  expect(await calls(page)).toEqual([])
})

test("a sensitive ask ignores Enter on Allow once and requires a click", async ({ page }) => {
  const request: PermissionRequest = {
    id: "perm_computer_sensitive",
    sessionID,
    permission: "computer_sensitive",
    patterns: ["window:42:7"],
    always: [appKey],
    metadata: {
      action: "click",
      why: "send",
      target: { appName: "Mail", appKey: "app:macos:com.apple.mail" },
      targetName: "Send",
    },
  }
  const fixture = await openAsk(page, request)
  const allow = fixture.dock.getByRole("button", { name: "Allow once", exact: true })
  await expect(
    fixture.dock.getByRole("heading", { name: `${Hands.NAME} wants to click “Send” in Mail`, exact: true }),
  ).toBeVisible()
  await expect(fixture.dock.getByText("This sends a message.", { exact: true })).toBeVisible()
  await expect(fixture.dock.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0)
  await expect(fixture.dock).not.toContainText("window:42:7")
  await fixture.advanceTo(700)
  await expect(allow).toBeEnabled()
  await allow.focus()
  await page.keyboard.press("Enter")
  await expect(fixture.dock).toBeVisible()
  expect(fixture.replies).toEqual([])
  try {
    await allow.click()
    await expect.poll(() => fixture.replies.length).toBe(1)
    expect(fixture.replies).toEqual([{ path: `/permission/${request.id}/reply`, body: { reply: "once" } }])
  } finally {
    await fixture.finishReply()
  }
  expect(await calls(page)).toEqual([])
})

async function openAsk(page: Page, request: PermissionRequest, options: { plan?: boolean } = {}) {
  const ask = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<void>()
  const replied = Promise.withResolvers<void>()
  const replies: { path: string; body: unknown }[] = []
  const prompts: unknown[] = []
  const events: unknown[] = []
  await page.clock.install()
  await installFakeComputer(
    page,
    { prefs: { enabled: true } },
    {
      directory,
      project: { id: "project-computer-asks", worktree: directory, vcs: "git", name: "Computer asks" },
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
                capabilities: { toolcall: true, input: { text: true, image: false }, output: { text: true } },
                modalities: { input: ["text"], output: ["text"] },
                tool_call: true,
              },
            },
          },
        ],
        connected: ["anthropic"],
        default: { anthropic: "fixture/text" },
      },
      sessions: [
        { id: sessionID, title, directory, projectID: "project-computer-asks", time: { created: 1, updated: 1 } },
      ],
      pageMessages: () => ({ items: [] }),
      capabilities: { backgroundSubagents: false, computer: { available: true, protocol: 1 } },
    },
  )
  // Hold the initial stream until the composer has focus, then deliver the real permission event shape.
  await page.route(/\/global\/event(?:\?|$)/, async (route) => {
    await ask.promise
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.splice(0).map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n",
    })
  })
  await page.route(/\/(?:permission\/[^/]+\/reply|session\/[^/]+\/permissions\/[^/?]+)(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    replies.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await reply.promise
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
    replied.resolve()
  })
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
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
  const composer = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
  await expect(composer).toBeVisible()
  if (options.plan) {
    // Plan mode is task-local rather than persisted: use the same mode menu as the person composing the message.
    const modeTrigger = page.locator('[data-action="prompt-mode"]')
    const modeGroup = page.getByRole("group", { name: "Mode", exact: true })
    await modeTrigger.click()
    await modeGroup.getByRole("button", { name: /^Plan\b/ }).click()
    await expect(modeTrigger).toHaveText("Plan")
    await modeGroup.waitFor({ state: "detached" })
    // Menu unmount restores trigger focus on a deferred timer; finish that before focusing the composer.
    await expect(modeTrigger).toBeFocused()
  }
  await composer.focus()
  await expect(composer).toBeFocused()
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  const appearedAt = await page.evaluate(() => Date.now())
  events.push({ directory, payload: { type: "permission.asked", properties: request } })
  ask.resolve()
  const dock = page.locator(dockSelector)
  // The first SDK event flush uses a zero-delay timer. Drain it without advancing the ask's arming clock.
  await expect
    .poll(async () => {
      await page.clock.runFor(0)
      return dock.isVisible()
    })
    .toBe(true)
  return {
    dock,
    composer,
    replies,
    prompts,
    async advanceTo(milliseconds: number) {
      const elapsed = (await page.evaluate(() => Date.now())) - appearedAt
      expect(elapsed).toBeLessThanOrEqual(milliseconds)
      await page.clock.runFor(milliseconds - elapsed)
    },
    async finishReply() {
      reply.resolve()
      if (replies.length) await replied.promise
    },
  }
}
