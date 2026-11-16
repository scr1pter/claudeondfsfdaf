import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { Hands } from "@vectordevai/schema/hands"
import type { Computer } from "@vectordevai/schema/computer"
import type { FakeComputerScript } from "../../src/features/computer/fake-platform"
import { calls, installFakeComputer, pushState, type ComputerTestWindow } from "../utils/fake-computer"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/ComputerSmoke"
const sessionID = "ses_computer_smoke"
const project = { id: "project-computer-smoke", worktree: directory, vcs: "git", name: "Computer smoke" }

async function openSettings(page: Page, script?: FakeComputerScript) {
  const server = {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [
      { id: sessionID, title: "Computer fixture", directory, projectID: project.id, time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
    ...(script
      ? {
          capabilities: {
            backgroundSubagents: false,
            computer: { available: script.supported !== false, protocol: 1 },
          },
        }
      : {}),
  }
  if (script) await installFakeComputer(page, script, server)
  else await mockVectorServer(page, server)
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
  await expectSessionTitle(page, "Computer fixture")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  return settings
}

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

test("the development computer fixture reaches Settings and accepts scripted state", async ({ page }) => {
  // Set up and granted, with main's live phase still off: the pill follows the phase main publishes next.
  const settings = await openSettings(page, {
    prefs: { enabled: true, consentedAt: 1 },
    state: { phase: "off" },
    permissions: granted,
  })
  const tab = settings.getByRole("tab", { name: Hands.NAME, exact: true })
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(settings.getByRole("heading", { name: Hands.NAME, exact: true })).toBeVisible()
  const status = settings.locator("[data-computer-status]").getByRole("status")
  await expect(status).toHaveText("Off")
  expect(await calls(page)).toEqual([])

  const state: Computer.ComputerState = {
    phase: "setup",
    backend: "local-macos",
    mode: "foreground",
    apps: [],
    queue: [],
    escStops: false,
    stopChord: Hands.STOP_CHORD.darwin,
    lease: 1,
    reduceMotion: true,
  }
  await pushState(page, state)
  await expect(status).toHaveText("Needs permissions")
  expect(await page.evaluate(() => (window as ComputerTestWindow).__vectorE2E!.computerControl!.state())).toEqual(state)
  await pushState(page, { ...state, phase: "ready" })
  await expect(status).toHaveText("Ready")
  await page.evaluate(() => (window as ComputerTestWindow).__vectorE2E!.computerControl!.command("stop"))
  expect(await calls(page)).toEqual([{ method: "command", command: "stop" }])
  const capabilities = await page.evaluate(async () => (await fetch("/experimental/capabilities")).json())
  expect(capabilities).toEqual({ backgroundSubagents: false, computer: { available: true, protocol: 1 } })
})

test("an unsupported desktop keeps its Settings status visible", async ({ page }) => {
  const settings = await openSettings(page, { supported: false })
  await settings.getByRole("tab", { name: Hands.NAME, exact: true }).click()
  await expect(settings.locator("[data-computer-status]").getByRole("status")).toHaveText("Not available on Linux yet")
  // No controls without a computer to control.
  await expect(settings.locator('[data-component="settings-computer"]').getByRole("switch")).toHaveCount(0)
  await expect(settings.locator('[data-component="settings-computer"]').getByRole("button")).toHaveCount(0)
  expect(await calls(page)).toEqual([])
})

test("ordinary web sessions have no computer surface and an older engine has no capabilities route", async ({
  page,
}) => {
  const settings = await openSettings(page)
  await expect(settings.getByRole("tab", { name: Hands.NAME, exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => !!(window as ComputerTestWindow).__vectorE2E?.computerControl)).toBe(false)
  expect(await page.evaluate(async () => (await fetch("/experimental/capabilities")).status)).toBe(404)
})
