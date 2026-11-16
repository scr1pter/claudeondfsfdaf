import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { FakeComputerScript } from "../../src/features/computer/fake-platform"
import { calls, installFakeComputer, pushInputSetup, type ComputerTestWindow } from "../utils/fake-computer"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/ComputerOnboarding"
const sessionID = "ses_computer_onboarding"
const title = "Computer onboarding fixture"
const denied = macPermissions("denied", "denied")
const screenOnly = macPermissions("granted", "denied")
const granted = macPermissions("granted", "granted")
const windows: Computer.PermissionsView = {
  rows: [],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
  windows: {
    captureBlocked: false,
    elevated: false,
    inputSetup: { state: "needs-calibration", mouse: false, keyboard: false },
  },
}

test("macOS records consent, refreshes grants by button, timer and focus, then enables only on Finish", async ({
  page,
}) => {
  const dialog = await openOnboarding(page, {
    permissions: denied,
    recheck: [denied, screenOnly, granted],
  })
  await expect(dialog.getByRole("heading", { name: "Let Vector use your apps", exact: true })).toBeVisible()
  await expect(dialog).toContainText("What it sees goes to the model you picked")
  await expect(dialog).toContainText("It never uses terminals, Vector itself, password managers or security settings")
  expect(await calls(page)).toEqual([])
  await consent(page, dialog)
  await expect(dialog.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible()
  await expect(dialog.locator('[data-permission="screen"]')).toContainText("Not granted")
  await expect(dialog.locator('[data-permission="accessibility"]')).toContainText("Not granted")
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()

  await dialog.getByRole("button", { name: "Check again", exact: true }).click()
  await expect(dialog.locator('[data-permission="screen"]')).toContainText("Not granted")
  await expect(dialog.getByRole("button", { name: "Check again", exact: true })).toBeEnabled()
  await page.clock.runFor(2000)
  await expect(dialog.locator('[data-permission="screen"]')).toContainText("Granted")
  await expect(dialog.locator('[data-permission="accessibility"]')).toContainText("Not granted")
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()

  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(dialog.locator('[data-permission="accessibility"]')).toContainText("Granted")
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled()
  await expectNoEnable(page)
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Try it", exact: true })).toBeVisible()
  await expectNoEnable(page)
  await finish(page, dialog)
})

test("Not now closes onboarding without recording consent or enabling", async ({ page }) => {
  const dialog = await openOnboarding(page, { permissions: granted })
  await dialog.getByRole("button", { name: "Not now", exact: true }).click()
  await page.clock.runFor(200)
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await page.clock.runFor(4000)
  expect(await calls(page)).toEqual([])
  expect((await preferences(page)).prefs.enabled).toBe(false)
  expect((await preferences(page)).prefs.consentedAt).toBeUndefined()
})

test("update resets and grants held by Vector show manual guidance without an unverified reset button", async ({
  page,
}) => {
  const dialog = await openOnboarding(page, {
    permissions: { ...denied, adhoc: true, vectorHoldsGrant: { screen: true, accessibility: true } },
    prefs: { granted: { helperVersion: "1.99.111", at: 1 } },
  })
  await expect(dialog).toContainText("Preview: this build of Vector isn't signed by its developer yet")
  await consent(page, dialog)
  await expect(dialog).toContainText("macOS turned this off after Vector updated")
  await expect(dialog).toContainText("Vector (the main app) also has Screen Recording or Accessibility")
  await expect(dialog.getByRole("button", { name: "Reset and ask again", exact: true })).toHaveCount(0)
  await dialog
    .locator('[data-permission="screen"]')
    .getByRole("button", { name: "Open System Settings", exact: true })
    .click()
  await dialog
    .locator('[data-permission="accessibility"]')
    .getByRole("button", { name: "Open System Settings", exact: true })
    .click()
  expect((await calls(page)).filter((call) => call.method === "openPane")).toEqual([
    { method: "openPane", id: "screen" },
    { method: "openPane", id: "accessibility" },
  ])
  expect((await calls(page)).filter((call) => call.method === "reset")).toEqual([])
  await expectNoEnable(page)
})

test("a verified reset acts only on the selected helper grant and refreshes its status", async ({ page }) => {
  const dialog = await openOnboarding(page, {
    permissions: { ...macPermissions("reset-after-update", "granted"), canReset: true, adhoc: true },
    reset: granted,
  })
  await consent(page, dialog)
  const reset = dialog.getByRole("button", { name: "Reset and ask again", exact: true })
  await expect(reset).toHaveCount(1)
  await reset.click()
  await expect(dialog.locator('[data-permission="screen"]')).toContainText("Granted")
  expect((await calls(page)).filter((call) => call.method === "reset")).toEqual([{ method: "reset", id: "screen" }])
  await expectNoEnable(page)
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await finish(page, dialog)
})

test("Windows requires both calibration deliveries and listener health before explicit Continue and Finish", async ({
  page,
}) => {
  const dialog = await openOnboarding(page, {
    state: { backend: "local-windows" },
    permissions: windows,
  })
  await expect(dialog).not.toContainText("Preview: this build")
  await expect(dialog).toContainText("No extra permission needed")
  await consent(page, dialog)
  const setup = await startWindowsCalibration(page, dialog)
  await expect(dialog.locator("[data-permission]")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Open System Settings", exact: true })).toHaveCount(0)
  await pushInputSetup(page, { state: "calibrating", mouse: true, keyboard: false })
  await page.clock.runFor(1000)
  await expect(setup.locator('[data-input-setup="mouse"]')).toHaveText("Mouse delivery: Verified")
  await expect(setup.locator('[data-input-setup="keyboard"]')).toHaveText("Keyboard delivery: Waiting")
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
  await expectNoEnable(page)

  await pushInputSetup(page, { state: "calibrating", mouse: true, keyboard: true })
  await page.clock.runFor(1000)
  await expect(setup).toContainText("Checking listener health…")
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
  await expectNoEnable(page)

  await completeWindowsCalibration(page, dialog)
  await finish(page, dialog)
})

for (const failure of [
  {
    name: "helper cannot start",
    permissions: { ...windows, helperStart: "failed" } satisfies Computer.PermissionsView,
    message: `${Hands.NAME} couldn't start its helper. Reinstall Vector, then try again.`,
  },
  {
    name: "Windows capture is blocked",
    permissions: { ...windows, windows: { captureBlocked: true, elevated: false } },
    message: "Windows is blocking screen capture for apps. Open Privacy & security and allow it for desktop apps.",
  },
  {
    name: "Vector is elevated",
    permissions: { ...windows, windows: { captureBlocked: false, elevated: true } },
    message: `Vector is running as administrator, so ${Hands.NAME} is off. Restart Vector normally to use it.`,
  },
]) {
  test(`Finish cannot enable after a fresh probe reports ${failure.name}`, async ({ page }) => {
    const dialog = await openOnboarding(page, {
      state: { backend: "local-windows" },
      permissions: windows,
      recheck: failure.permissions,
    })
    await consent(page, dialog)
    await startWindowsCalibration(page, dialog)
    await completeWindowsCalibration(page, dialog)
    await dialog.getByRole("button", { name: "Finish", exact: true }).click()
    await expect(dialog.getByText(failure.message, { exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Finish", exact: true, disabled: false })).toHaveCount(0)
    await expectNoEnable(page)
    expect((await preferences(page)).prefs.enabled).toBe(false)
    if (failure.permissions.windows?.captureBlocked) {
      await dialog.getByRole("button", { name: "Open Privacy & security", exact: true }).click()
      expect((await calls(page)).filter((call) => call.method === "openPane")).toEqual([
        { method: "openPane", id: "windows-capture" },
      ])
    }
  })
}

function macPermissions(
  screen: Computer.PermissionsView["rows"][number]["status"],
  accessibility: Computer.PermissionsView["rows"][number]["status"],
): Computer.PermissionsView {
  return {
    rows: [
      {
        id: "screen",
        status: screen,
        pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      },
      {
        id: "accessibility",
        status: accessibility,
        pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      },
    ],
    canReset: false,
    adhoc: false,
    helperStart: "ok",
    vectorHoldsGrant: { screen: false, accessibility: false },
  }
}

async function openOnboarding(page: Page, script: FakeComputerScript) {
  await page.clock.install()
  const project = { id: "project-computer-onboarding", worktree: directory, vcs: "git", name: "Computer onboarding" }
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
  await settings.getByRole("tab", { name: Hands.NAME, exact: true }).click()
  const use = settings.getByRole("switch", { name: `Use ${Hands.NAME}` })
  await expect(use).toBeEnabled()
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  await use.click({ force: true })
  const dialog = page.locator('[data-component="computer-onboarding"]')
  await expect(dialog).toBeVisible()
  // Onboarding replaces Settings (D6b.4), so only onboarding's own checks run from here.
  await expect(settings).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: `Turn on ${Hands.NAME}`, exact: true })).toBeEnabled()
  return dialog
}

async function consent(page: Page, dialog: Locator) {
  await dialog.getByRole("button", { name: `Turn on ${Hands.NAME}`, exact: true }).click()
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "setPrefs"))
    .toEqual([{ method: "setPrefs", prefs: { consentedAt: expect.any(Number) } }])
  expect((await preferences(page)).prefs.consentedAt).toBeGreaterThan(0)
  await expectNoEnable(page)
}

async function expectNoEnable(page: Page) {
  expect((await calls(page)).filter((call) => call.method === "setPrefs" && call.prefs.enabled === true)).toEqual([])
}

async function startWindowsCalibration(page: Page, dialog: Locator) {
  await expect(dialog.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
  const setup = dialog.locator('[data-component="computer-input-setup"]')
  await setup.getByRole("button", { name: "Start calibration", exact: true }).click()
  await expect(setup).toContainText("Waiting for your mouse and keyboard")
  expect((await calls(page)).filter((call) => call.method === "inputSetup" && call.action === "start")).toEqual([
    { method: "inputSetup", action: "start" },
  ])
  await expectNoEnable(page)
  return setup
}

async function completeWindowsCalibration(page: Page, dialog: Locator) {
  // The fake emits native metadata explicitly. Playwright mouse/key events are not hardware proof.
  await pushInputSetup(page, { state: "ready", mouse: true, keyboard: true })
  // One component poll; the two-second onboarding probe in the final-failure cases stays for Finish.
  await page.clock.runFor(1000)
  const setup = dialog.locator('[data-component="computer-input-setup"]')
  await expect(setup).toContainText("Calibrated — listener healthy")
  await expect(setup.locator('[data-input-setup="mouse"]')).toHaveText("Mouse delivery: Verified")
  await expect(setup.locator('[data-input-setup="keyboard"]')).toHaveText("Keyboard delivery: Verified")
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled()
  await expectNoEnable(page)
  expect((await calls(page)).filter((call) => call.method === "command" && call.command === "resume")).toEqual([])
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Try it", exact: true })).toBeVisible()
  await expectNoEnable(page)
}

async function finish(page: Page, dialog: Locator) {
  await dialog.getByRole("button", { name: "Finish", exact: true }).click()
  await expect
    .poll(
      async () =>
        (await calls(page)).filter((call) => call.method === "setPrefs" && call.prefs.enabled === true).length,
    )
    .toBe(1)
  expect((await preferences(page)).prefs).toMatchObject({ enabled: true, consentedAt: expect.any(Number) })
  await page.clock.runFor(200)
  await expect(dialog).toHaveCount(0)
}

async function preferences(page: Page) {
  return page.evaluate(() => {
    const computer = (window as ComputerTestWindow).__vectorE2E?.computerControl
    if (!computer) throw new Error("The computer fixture was not installed before navigation")
    return computer.prefs()
  })
}
