import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { FakeComputerScript } from "../../src/features/computer/fake-platform"
import { installFakeComputer, type ComputerTestWindow } from "../utils/fake-computer"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/ComputerMentions"
const sessionID = "ses_computer_mentions"
const title = "Computer mention fixture"
// A valid 1x1 PNG, inside the icon size limit.
const icon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const numbers = { key: "app:macos:com.apple.iwork.numbers", name: "Numbers", running: true, icon }
const apps: Awaited<ReturnType<Computer.ComputerPlatform["apps"]>> = [
  numbers,
  { key: "app:macos:com.apple.textedit", name: "TextEdit", running: false },
  { key: "app:macos:com.apple.terminal", name: "Terminal", running: true, rule: "never" },
  { key: "app:macos:com.microsoft.excel@ubf8t346g9", name: "Excel", running: false, rule: "company-deny" },
]
// One permission view (not a sequence): every read sees the same granted state.
const granted: Computer.PermissionsView = {
  rows: [
    {
      id: "screen",
      status: "granted",
      pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    },
    {
      id: "accessibility",
      status: "granted",
      pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    },
  ],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
}
const ready: FakeComputerScript = { prefs: { enabled: true, consentedAt: 1 }, permissions: granted, apps }
const capable = { backgroundSubagents: false, computer: { available: true, protocol: 1 } }

test("@han finds the feature row, @Num finds Numbers with its icon, and never-listed apps never appear", async ({
  page,
}) => {
  const { composer } = await openComposer(page, ready)
  await composer.pressSequentially("@han")
  const feature = page.locator('[data-computer-row="feature"]')
  await expect(feature).toContainText(`@${Hands.MENTION}`)
  await expect(feature).toContainText("Let Vector use apps on your computer")

  await clear(page, "@han")
  await composer.pressSequentially("@Num")
  const row = page.locator('[data-computer-row="app"]', { hasText: "@Numbers" })
  await expect(row).toBeVisible()
  const image = row.locator("img")
  await expect(image).toHaveAttribute("alt", "")
  expect(await image.getAttribute("src")).toMatch(/^data:image\/png;base64,/)

  // TextEdit's row shows the "@T" lookup finished; Terminal is never listed.
  await clear(page, "@Num")
  await composer.pressSequentially("@T")
  await expect(page.locator('[data-computer-row="app"]', { hasText: "@TextEdit" })).toBeVisible()
  await expect(page.locator('[data-computer-row="app"]', { hasText: "Terminal" })).toHaveCount(0)
  // Whatever the apps' match scores, @Hands leads the Computer group.
  await expect(page.locator("[data-computer-row]").first()).toHaveAttribute("data-computer-row", "feature")
})

test("a company-denied app is dimmed and can be picked neither by pointer nor by keyboard", async ({ page }) => {
  const { composer } = await openComposer(page, ready)
  await composer.pressSequentially("@Exc")
  const excel = page.locator('[data-computer-row="app"]', { hasText: "@Excel" })
  await expect(excel).toBeVisible()
  await expect(excel).toContainText("Your company doesn't allow this app")
  await expect(excel).toBeDisabled()
  await expect(excel).toHaveAttribute("aria-disabled", "true")
  await excel.click({ force: true })
  await page.keyboard.press("Enter")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await page.keyboard.press("Tab")
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(0)
})

test("sending @Hands and @Numbers posts exactly the documented marker shapes", async ({ page }) => {
  const { composer, prompts } = await openComposer(page, ready, capable)
  await composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Let Vector use apps on your computer")
  await page.keyboard.press("Enter")
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)
  await composer.pressSequentially("@Num")
  await page.locator('[data-computer-row="app"]', { hasText: "@Numbers" }).click()
  await expect(composer.locator('[data-type="computer"][data-app-key]')).toHaveAttribute("data-app-key", numbers.key)
  await composer.pressSequentially("put the receipts in a table")
  await page.keyboard.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  const parts = (prompts[0] as { parts: { metadata?: Record<string, unknown> }[] }).parts
  // Each marker, without its generated id, is exactly the documented shape: no other field rides along.
  const markers = parts
    .filter((part) => part.metadata?.[Hands.MARKER])
    .map((part) => Object.fromEntries(Object.entries(part).filter(([key]) => key !== "id")))
  expect(markers).toEqual([
    { type: "text", text: "", synthetic: true, metadata: { [Hands.MARKER]: { kind: "feature" } } },
    {
      type: "text",
      text: "",
      synthetic: true,
      metadata: { [Hands.MARKER]: { kind: "app", key: numbers.key, name: "Numbers" } },
    },
  ])
})

test("a model that cannot see images shows the screen-reader note under the composer while a pill is in the draft", async ({
  page,
}) => {
  // The fixture's only model reads text alone (capabilities.input.image false).
  const { composer } = await openComposer(page, ready)
  const note = page.locator('[data-component="computer-reader-notice"]')
  await composer.pressSequentially("put the receipts in a table ")
  await expect(note).toHaveCount(0)
  await composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Let Vector use apps on your computer")
  await page.keyboard.press("Enter")
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)
  await expect(note).toBeVisible()
  await expect(note).toHaveAttribute("role", "note")
  await expect(note).toHaveText(
    new RegExp(
      `^.+ can't see the screen, so ${Hands.NAME} will read app controls instead\\. That works in fewer apps\\. A model that can see images works best\\.$`,
    ),
  )
  // It sits below the composer, not over the draft.
  const [notice, input] = await Promise.all([note.boundingBox(), composer.boundingBox()])
  expect(notice!.y).toBeGreaterThanOrEqual(input!.y + input!.height - 1)
  // Without a pill, nothing runs Hands, so the note leaves.
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(0)
  await expect(note).toHaveCount(0)
})

test("when Hands is not set up, the pill opens onboarding and sending shows Set up instead of posting", async ({
  page,
}) => {
  const { composer, prompts } = await openComposer(page, { ...ready, prefs: { enabled: false } }, capable)
  await composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Off — set it up")
  await page.keyboard.press("Enter")
  const dialog = page.locator('[data-component="computer-onboarding"]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Not now", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)

  await composer.focus()
  await page.keyboard.press("End")
  await composer.pressSequentially("open my receipts")
  await page.keyboard.press("Enter")
  await expect(page.getByText(`Set up ${Hands.NAME} first`)).toBeVisible()
  await page.getByRole("button", { name: "Set up", exact: true }).click()
  await expect(dialog).toBeVisible()
  expect(prompts).toEqual([])
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)
})

test("an engine without the computer capability refuses the send and keeps the draft", async ({ page }) => {
  const { composer, prompts } = await openComposer(page, ready)
  await composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Let Vector use apps on your computer")
  await page.keyboard.press("Enter")
  await composer.pressSequentially("open my receipts")
  await page.keyboard.press("Enter")
  await expect(page.getByText("This engine cannot run this request")).toBeVisible()
  await expect(page.getByText(`${Hands.NAME} is not available on this engine`)).toBeVisible()
  expect(prompts).toEqual([])
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)
})

test("what setup cannot fix shows its own sentence on the @Hands row, and choosing it opens no onboarding", async ({
  page,
}) => {
  const { composer, prompts } = await openComposer(page, { ...ready, policy: { enabled: false } }, capable)
  const sentence = `Your company turned off ${Hands.NAME}.`
  await composer.pressSequentially("@han")
  const feature = page.locator('[data-computer-row="feature"]')
  await expect(feature).toContainText(sentence)
  await expect(feature).not.toContainText("Off — set it up")
  await page.keyboard.press("Enter")
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)

  // By the time the send is refused with the same sentence, the selection's readiness read has long finished.
  await composer.pressSequentially("open my receipts")
  await page.keyboard.press("Enter")
  await expect(page.getByText(sentence)).toBeVisible()
  await expect(page.getByRole("button", { name: "Set up", exact: true })).toHaveCount(0)
  await expect(page.locator('[data-component="computer-onboarding"]')).toHaveCount(0)
  expect(prompts).toEqual([])
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(1)
})

test("a queued @Hands message is checked again when the queue sends it, and stays queued when refused", async ({
  page,
}) => {
  const events: unknown[] = []
  // The session is still running, so Enter queues the message behind it.
  let status: Record<string, unknown> = { [sessionID]: { type: "busy" } }
  const { composer, prompts } = await openComposer(page, ready, capable, {
    events: () => events.splice(0),
    status: () => status,
  })
  await composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Let Vector use apps on your computer")
  await page.keyboard.press("Enter")
  await composer.pressSequentially("open my receipts")
  await page.keyboard.press("Enter")
  const dock = page.locator('[data-component="session-followup-dock"]')
  await expect(dock).toContainText("open my receipts")
  await expect(composer.locator('[data-type="computer"]')).toHaveCount(0)

  // Hands is turned off while the message waits. When the run ends, the queue sends it and the dispatch check refuses.
  await setPrefs(page, { enabled: false })
  status = {}
  events.push({ directory, payload: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
  await expect(page.getByText(`Set up ${Hands.NAME} first`)).toBeVisible()
  await expect(page.getByRole("button", { name: "Set up", exact: true })).toBeVisible()
  await expect(dock).toContainText("open my receipts")
  expect(prompts).toEqual([])

  // Turned on again, the dock's Send sends that message once, with its marker.
  await setPrefs(page, { enabled: true })
  await dock.getByRole("button", { name: "Steer", exact: true }).click()
  await expect.poll(() => prompts.length).toBe(1)
  const parts = (prompts[0] as { parts: { metadata?: Record<string, unknown> }[] }).parts
  expect(parts.filter((part) => part.metadata?.[Hands.MARKER]).map((part) => part.metadata?.[Hands.MARKER])).toEqual([
    { kind: "feature" },
  ])
  await expect(dock).toHaveCount(0)
})

test("app rows that land late keep the files in view and the row the user moved to", async ({ page }) => {
  // Eight listable apps contain an "o"; their answer waits until the test releases it.
  const many = ["Notes", "Contacts", "Console", "Photos", "Books", "Podcasts", "Clock", "Voice Memos"].map((name) => ({
    key: `app:macos:com.apple.${name.toLowerCase().replace(" ", "")}`,
    name,
    running: false,
  }))
  const files = ["docs/onboarding.md", "docs/overview.md", "src/options.ts", "src/order.ts"]
  const { composer } = await openComposer(page, { ...ready, apps: many, holdApps: true })
  await page.route(/\/find\/file(?:\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(new URL(route.request().url()).searchParams.get("query") === "o" ? files : []),
    }),
  )
  const file = (path: string) => page.locator("button", { hasText: path.split("/").pop() })
  const chosen = file("docs/overview.md")
  await composer.pressSequentially("@o")
  // @Hands matches "o" and leads; the files follow it while the app lookup is still out.
  await expect(page.locator('[data-computer-row="feature"]')).toBeVisible()
  await expect(chosen).toBeVisible()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(chosen).toHaveClass(/bg-v2-overlay-simple-overlay-hover/)

  // When the apps land, at most three join the list beside file results, every file stays in view, and the row the
  // user moved to stays chosen.
  await page.evaluate(() => (window as ComputerTestWindow).__vectorE2E?.computerControl?.releaseApps())
  await expect(page.locator('[data-computer-row="app"]')).toHaveCount(3)
  for (const path of files) await expect(file(path)).toBeVisible()
  await expect(chosen).toHaveClass(/bg-v2-overlay-simple-overlay-hover/)
  await page.keyboard.press("Enter")
  await expect(composer.locator('[data-type="file"]')).toHaveAttribute("data-path", "docs/overview.md")

  // A query that finds no files lists every matching app.
  await composer.pressSequentially(" @s")
  await expect(page.locator('[data-computer-row="app"]')).toHaveCount(7)
})

test("a message sent while a queued @Hands message is checked at dispatch queues behind it", async ({ page }) => {
  const events: unknown[] = []
  let status: Record<string, unknown> = { [sessionID]: { type: "busy" } }
  const idle = () => {
    status = {}
    events.push({ directory, payload: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
  }
  const { composer, prompts } = await openComposer(page, ready, capable, {
    events: () => events.splice(0),
    status: () => status,
  })
  await composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Let Vector use apps on your computer")
  await page.keyboard.press("Enter")
  await composer.pressSequentially("open my receipts")
  await page.keyboard.press("Enter")
  const dock = page.locator('[data-component="session-followup-dock"]')
  await expect(dock).toContainText("open my receipts")

  // The dispatch check's engine request waits for the test, well within its 5 s limit.
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let checks = 0
  await page.route(/\/experimental\/capabilities(?:\?|$)/, async (route) => {
    checks++
    await held
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(capable),
    })
  })
  idle()
  await expect.poll(() => checks).toBe(1)

  // The session is idle, but the queued message is being sent: the newer one queues behind it.
  await composer.pressSequentially("and email")
  await page.keyboard.press("Enter")
  await expect(dock).toContainText("and email")
  expect(prompts).toEqual([])

  // Like the engine, status reads report the run the queued message starts.
  status = { [sessionID]: { type: "busy" } }
  release()
  await expect.poll(() => prompts.length).toBe(1)
  const first = (prompts[0] as { parts: { text?: string; metadata?: Record<string, unknown> }[] }).parts
  expect(first.filter((part) => part.metadata?.[Hands.MARKER]).map((part) => part.metadata?.[Hands.MARKER])).toEqual([
    { kind: "feature" },
  ])
  // The newer message waits for the run the first one started.
  idle()
  await expect.poll(() => prompts.length).toBe(2)
  const second = (prompts[1] as { parts: { text?: string }[] }).parts
  expect(second.some((part) => part.text?.includes("and email"))).toBe(true)
  await expect(dock).toHaveCount(0)
})

async function setPrefs(page: Page, prefs: Partial<Computer.ComputerPrefs>) {
  await page.waitForFunction(() => !!(window as ComputerTestWindow).__vectorE2E?.computerControl)
  await page.evaluate(async (next) => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    await control.setPrefs(next)
  }, prefs)
}

async function clear(page: Page, typed: string) {
  for (const key of Array.from(typed, () => "Backspace")) await page.keyboard.press(key)
}

async function openComposer(
  page: Page,
  script: FakeComputerScript,
  capabilities?: unknown,
  server: { events?: () => unknown[]; status?: () => unknown } = {},
) {
  const prompts: unknown[] = []
  await installFakeComputer(page, script, {
    directory,
    project: { id: "project-computer-mentions", worktree: directory, vcs: "git", name: "Computer mentions" },
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
      { id: sessionID, title, directory, projectID: "project-computer-mentions", time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
    // Omitted, the mock engine answers the capabilities route with 404, as an older engine does.
    capabilities,
    ...(server.events ? { events: server.events, eventRetry: 50 } : {}),
  })
  // A reconnecting stream may reread session status, so it changes with the events.
  const status = server.status
  if (status)
    await page.route(/\/session\/status(?:\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(status()),
      }),
    )
  await page.route(/\/find\/file(?:\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )
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
  await composer.focus()
  await expect(composer).toBeFocused()
  return { composer, prompts }
}
