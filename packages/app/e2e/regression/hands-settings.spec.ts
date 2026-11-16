import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { FakeComputerScript } from "../../src/features/computer/fake-platform"
import { calls, installFakeComputer, type ComputerTestWindow } from "../utils/fake-computer"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/ComputerSettings"
const sessionID = "ses_computer_settings"
const title = "Computer settings fixture"
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
const windows: Computer.PermissionsView = {
  rows: [],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
  windows: { captureBlocked: false, elevated: false },
}
const enabled: FakeComputerScript = { prefs: { enabled: true, consentedAt: 1 }, permissions: granted }

test("Settings search finds the Hands page by its words and leaves keyboard and terminal where they were", async ({
  page,
}) => {
  const settings = await openSettings(page, enabled, false)
  const search = settings.getByRole("searchbox", { name: "Search settings" })
  const visibleTabs = settings.locator('[role="tab"]:visible')
  for (const query of ["hands", "always allowed apps", "screenshots", "mouse"]) {
    await search.fill(query)
    await expect(visibleTabs).toHaveText([Hands.NAME])
  }
  await search.fill("keyboard")
  await expect(visibleTabs).toHaveText(["Keyboard shortcuts"])
  await search.fill("terminal")
  await expect(visibleTabs).toHaveText(["General"])
  await search.fill("hands")
  await visibleTabs.click()
  await expect(settings.getByRole("heading", { name: Hands.NAME, exact: true })).toBeVisible()
  await expect(status(settings)).toHaveText("Ready")
  expect(await calls(page)).toEqual([])
})

test("Remove and Remove all take apps off the always-allowed list", async ({ page }) => {
  const settings = await openSettings(page, {
    ...enabled,
    always: [
      { key: "app:macos:com.apple.notes", name: "Notes", publisher: "Apple Inc.", addedAt: Date.UTC(2026, 9, 1) },
      { key: "app:macos:com.acme.ledger", name: "Ledger", teamId: "ABCDE12345", addedAt: Date.UTC(2026, 9, 2) },
      { key: "app:macos:com.apple.mail", name: "Mail", addedAt: Date.UTC(2026, 9, 3) },
    ],
  })
  const always = settings.locator('[data-section="always"]')
  const notes = always.locator('[data-key="app:macos:com.apple.notes"]')
  await expect(notes).toContainText("From Apple Inc.")
  await expect(always.locator('[data-key="app:macos:com.acme.ledger"]')).toContainText("Developer team ABCDE12345")
  await notes.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(notes).toHaveCount(0)
  expect(await calls(page)).toEqual([{ method: "removeAlways", key: "app:macos:com.apple.notes" }])
  await always.getByRole("button", { name: "Remove all", exact: true }).click()
  await expect(always).toContainText("When you choose Always allow, the app appears here.")
  expect(await calls(page)).toEqual([
    { method: "removeAlways", key: "app:macos:com.apple.notes" },
    { method: "removeAllAlways" },
  ])
})

test("company-locked controls are disabled with the label, company rules are read-only and retention is capped", async ({
  page,
}) => {
  const settings = await openSettings(page, {
    prefs: { enabled: true, consentedAt: 1, mode: "background", keepAwake: true, retention: "30d" },
    permissions: granted,
    policy: {
      managed: true,
      background: false,
      keepAwake: false,
      maxRetentionDays: 7,
      apps: [
        ["app:macos:com.apple.calculator", "allow"],
        ["app:macos:com.microsoft.excel", "deny"],
      ],
      ignored: ["com.example.tool"],
    },
    locked: ["mode", "keepAwake"],
  })
  const working = settings.locator('[data-section="working"]')
  await expect(working.getByRole("radio", { name: "Alongside me" })).toBeDisabled()
  await expect(working.getByRole("radio", { name: "Take the screen" })).toBeDisabled()
  await expect(working.getByRole("radio", { name: "Take the screen" })).toBeChecked()
  const keepAwake = working.getByRole("switch", { name: "Keep the screen awake while it works" })
  await expect(keepAwake).toBeDisabled()
  await expect(keepAwake).not.toBeChecked()
  await expect(working.getByText("Set by your company", { exact: true })).toHaveCount(2)
  await expect(working.getByRole("switch", { name: "Notify me when it starts and finishes" })).toBeEnabled()

  const company = settings.locator('[data-section="company"]')
  await expect(company.locator('[data-company="allowed"]')).toContainText("com.apple.calculator")
  await expect(company.locator('[data-company="denied"]')).toContainText("com.microsoft.excel")
  await expect(company).toContainText("Rule for com.example.tool ignored: add its Team ID.")
  await expect(company).toContainText(`${Hands.NAME} still asks before using an app your company allows.`)
  await expect(company.getByRole("button")).toHaveCount(0)

  const retention = settings.locator('[data-row="retention"] [data-component="select-v2"]')
  await expect(retention).toHaveText("7 days")
  await retention.click()
  for (const option of ["Until the task ends", "1 day", "7 days"])
    await expect(page.getByRole("option", { name: option, exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "30 days", exact: true })).toHaveCount(0)
  await expect(page.getByRole("option", { name: "Until I delete the conversation", exact: true })).toHaveCount(0)
  const day = page.getByRole("option", { name: "1 day", exact: true })
  // The list must sit above the full-screen Settings dialog, not merely be in the accessibility tree.
  expect(
    await day.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    }),
  ).toBe(true)
  await day.click()
  await expect.poll(() => calls(page)).toEqual([{ method: "setPrefs", prefs: { retention: "1d" } }])
})

test("a mode or mouse choice main does not keep, or fails to save, leaves the saved choice selected", async ({
  page,
}) => {
  const settings = await openSettings(page, enabled)
  const working = settings.locator('[data-section="working"]')
  const alongside = working.getByRole("radio", { name: "Alongside me" })
  const screen = working.getByRole("radio", { name: "Take the screen" })
  const ask = working.getByRole("radio", { name: "Ask me first" })
  const take = working.getByRole("radio", { name: "Just take it" })
  await expect(screen).toBeChecked()
  await expect(ask).toBeChecked()

  // Main keeps Take the screen where the helper cannot work in the background (D6b.5).
  await page.evaluate(() => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    control.setPrefs = () => control.prefs()
  })
  await alongside.click()
  await expect(screen).toBeChecked()
  await expect(alongside).not.toBeChecked()

  // A rejected save publishes no settings; the clicked radio must still give way to the saved one.
  await page.evaluate(() => {
    const control = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!control) throw new Error("The computer fixture was not installed before navigation")
    control.setPrefs = () => Promise.reject(new Error("The preference store is read-only"))
  })
  await take.click()
  await expect(settings.getByRole("alert")).toHaveText(`Could not save ${Hands.NAME} settings. Try again.`)
  await expect(ask).toBeChecked()
  await expect(take).not.toBeChecked()
  await alongside.click()
  await expect(screen).toBeChecked()
  await expect(alongside).not.toBeChecked()
})

test("Delete all screenshots asks first; Cancel deletes nothing and Delete deletes once", async ({ page }) => {
  const settings = await openSettings(page, { ...enabled, removedScreenshots: 4 })
  const screenshots = settings.locator('[data-section="screenshots"]')
  const confirm = screenshots.getByRole("group", { name: "Delete all screenshots?" })
  await screenshots.getByRole("button", { name: "Delete all screenshots", exact: true }).click()
  await expect(confirm).toContainText("This can't be undone.")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  expect(await calls(page)).toEqual([])

  await screenshots.getByRole("button", { name: "Delete all screenshots", exact: true }).click()
  await confirm.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(screenshots.getByText("Deleted 4 screenshots.", { exact: true })).toBeVisible()
  expect(await calls(page)).toEqual([{ method: "deleteScreenshots" }])
})

test("blocked apps: built-in groups are fixed, defaults can be allowed, and your own blocks can be added and removed", async ({
  page,
}) => {
  const settings = await openSettings(page, {
    ...enabled,
    builtins: [
      { key: "builtin:terminal", name: "Terminal", reason: "terminal", removable: false },
      { key: "builtin:tradingview", name: "TradingView", reason: "user", removable: true },
      { key: "builtin:binance", name: "Binance", reason: "user", removable: true },
      { key: "builtin:find-my", name: "Find My", reason: "user", removable: true },
    ],
    prefs: {
      enabled: true,
      consentedAt: 1,
      blocked: [{ key: "app:macos:com.example.textexpander", name: "TextExpander", addedAt: 0 }],
    },
    apps: [
      { key: "app:macos:com.apple.textedit", name: "TextEdit", running: true },
      { key: "app:macos:com.apple.terminal", name: "Terminal", running: true, rule: "never" },
      { key: "app:macos:com.example.textexpander", name: "TextExpander", running: false },
    ],
  })
  const blocked = settings.locator('[data-section="blocked"]')
  const builtin = blocked.locator('[data-blocked="builtin"]')
  for (const group of [
    "Terminals and script tools",
    "Vector",
    "System Settings and security prompts",
    "Password managers and Keychain",
    "Remote desktop and virtual machine viewers",
  ])
    await expect(builtin).toContainText(group)
  await expect(builtin.getByRole("button")).toHaveCount(0)

  const trading = blocked.locator('[data-blocked="default"] [data-group="finance"]')
  await expect(trading).toContainText("Trading and crypto apps")
  await trading.getByRole("button", { name: "Allow", exact: true }).click()
  await expect(trading.getByRole("button", { name: "Block", exact: true })).toBeVisible()
  expect(await calls(page)).toEqual([
    { method: "setPrefs", prefs: { unblocked: ["builtin:tradingview", "builtin:binance"] } },
  ])

  const yours = blocked.locator('[data-blocked="yours"]')
  await yours.getByRole("button", { name: "Block an app…", exact: true }).click()
  await yours.getByRole("searchbox", { name: "Search apps" }).fill("Te")
  const results = yours.getByRole("list", { name: "Search apps" })
  await expect(results.getByText("TextEdit", { exact: true })).toBeVisible()
  await expect(results.getByText("Terminal", { exact: true })).toHaveCount(0)
  await expect(results.getByText("TextExpander", { exact: true })).toHaveCount(0)
  await results.getByRole("button", { name: "Block TextEdit", exact: true }).click()
  await expect(yours.locator('[data-key="app:macos:com.apple.textedit"]')).toContainText("TextEdit")
  expect((await calls(page)).at(-1)).toEqual({
    method: "block",
    app: { key: "app:macos:com.apple.textedit", name: "TextEdit" },
  })

  const textExpander = yours.locator('[data-key="app:macos:com.example.textexpander"]')
  await textExpander.getByRole("button", { name: "Unblock", exact: true }).click()
  await expect(textExpander).toHaveCount(0)
  expect((await calls(page)).at(-1)).toEqual({ method: "unblock", key: "app:macos:com.example.textexpander" })
})

test("turning Use on opens onboarding in place of Settings without enabling; turning it off writes enabled false", async ({
  page,
}) => {
  const settings = await openSettings(page, { permissions: granted })
  await expect(status(settings)).toHaveText("Off")
  const use = settings.getByRole("switch", { name: `Use ${Hands.NAME}` })
  await expect(use).toBeEnabled()
  await use.click({ force: true })
  await expect(page.locator('[data-component="computer-onboarding"]')).toBeVisible()
  // Onboarding replaces the Settings dialog (D6b.4); only its Finish turns Hands on.
  await expect(settings).toHaveCount(0)
  expect((await calls(page)).filter((call) => call.method === "setPrefs")).toEqual([])
})

test("turning Use off records enabled false", async ({ page }) => {
  const settings = await openSettings(page, enabled)
  await expect(status(settings)).toHaveText("Ready")
  const use = settings.getByRole("switch", { name: `Use ${Hands.NAME}` })
  await expect(use).toBeChecked()
  await use.click({ force: true })
  await expect(use).not.toBeChecked()
  await expect(status(settings)).toHaveText("Off")
  expect(await calls(page)).toEqual([{ method: "setPrefs", prefs: { enabled: false } }])
})

test("the Reduced motion setting reaches the desktop, and only when it changes", async ({ page }) => {
  const settings = await openSettings(page, enabled, false)
  await settings.getByRole("tab", { name: "Accessibility", exact: true }).click()
  const reduced = settings.locator(".settings-v2-row-modern", { hasText: "Reduced motion" }).getByRole("switch")
  expect(await calls(page)).toEqual([])
  await reduced.click({ force: true })
  await expect.poll(() => calls(page)).toEqual([{ method: "setPrefs", prefs: { reduceMotion: true } }])
  await reduced.click({ force: true })
  await expect
    .poll(() => calls(page))
    .toEqual([
      { method: "setPrefs", prefs: { reduceMotion: true } },
      { method: "setPrefs", prefs: { reduceMotion: false } },
    ])
})

test("Change records a new stop shortcut, Esc cancels, and a bad chord explains itself", async ({ page }) => {
  const settings = await openSettings(page, enabled)
  const stop = settings.locator('[data-row="stop"]')
  await expect(stop).toContainText("This shortcut stops it any time: ⌘⇧Esc")
  const recorder = stop.getByRole("textbox", { name: "Press the new shortcut, or Esc to cancel." })

  await stop.getByRole("button", { name: "Change", exact: true }).click()
  await expect(recorder).toBeFocused()
  await page.keyboard.press("Control+K")
  await expect(stop.getByRole("alert")).toHaveText(
    "Hold at least two modifier keys and press a letter, number, F1 to F12 or Esc.",
  )
  await page.keyboard.press("Escape")
  await expect(recorder).toHaveCount(0)
  await expect(settings).toBeVisible()
  expect(await calls(page)).toEqual([])

  await stop.getByRole("button", { name: "Change", exact: true }).click()
  await expect(recorder).toBeFocused()
  await page.keyboard.press("Control+Shift+K")
  await expect(stop).toContainText("This shortcut stops it any time: ⌃⇧K")
  expect(await calls(page)).toEqual([{ method: "setPrefs", prefs: { stopChord: "Control+Shift+K" } }])
})

test("an Escape stop shortcut is recorded on Windows without closing Settings", async ({ page }) => {
  const settings = await openSettings(page, {
    prefs: { enabled: true, consentedAt: 1, stopChord: "Control+Alt+Shift+K" },
    state: { backend: "local-windows" },
    permissions: windows,
  })
  const stop = settings.locator('[data-row="stop"]')
  await expect(stop).toContainText("This shortcut stops it any time: Ctrl+Alt+Shift+K")
  await stop.getByRole("button", { name: "Change", exact: true }).click()
  await expect(stop.getByRole("textbox", { name: "Press the new shortcut, or Esc to cancel." })).toBeFocused()
  await page.keyboard.press("Control+Alt+Shift+Escape")
  await expect(stop).toContainText("This shortcut stops it any time: Ctrl+Alt+Shift+Esc")
  await expect(settings).toBeVisible()
  expect((await calls(page)).filter((call) => call.method !== "inputSetup" || call.action !== "status")).toEqual([
    { method: "setPrefs", prefs: { stopChord: Hands.STOP_CHORD.win32 } },
  ])
  // Windows has no macOS mode or pointer choices.
  await expect(settings.getByRole("radio")).toHaveCount(0)
})

function status(settings: Locator) {
  return settings.locator("[data-computer-status]").getByRole("status")
}

async function openSettings(page: Page, script: FakeComputerScript, openTab = true) {
  const project = { id: "project-computer-settings", worktree: directory, vcs: "git", name: "Computer settings" }
  await installFakeComputer(page, script, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, title, directory, projectID: project.id, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
    capabilities: { backgroundSubagents: false, computer: { available: true, protocol: 1 } },
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
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  if (!openTab) return settings
  await settings.getByRole("tab", { name: Hands.NAME, exact: true }).click()
  await expect(settings.getByRole("heading", { name: Hands.NAME, exact: true })).toBeVisible()
  await expect(status(settings)).toBeVisible()
  return settings
}
