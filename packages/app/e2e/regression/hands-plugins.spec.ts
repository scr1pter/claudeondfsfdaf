import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { Hands } from "@vectordevai/schema/hands"
import type { FakeComputerScript } from "../../src/features/computer/fake-platform"
import { installFakeComputer } from "../utils/fake-computer"
import { mockVectorServer, type MockServerConfig } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/PluginsCatalog"
const sessionID = "ses_plugins_catalog"
const title = "Plugins catalog fixture"
const project = { id: "project-plugins-catalog", worktree: directory, vcs: "git", name: "Plugins catalog" }
const name = "Computer Control (community MCP)"
const handsBlurb = `Third-party desktop control without ${Hands.NAME}' per-app asks, glow or stop key. Prefer @${Hands.MENTION}.`
const neutralBlurb = "Third-party desktop control: see the screen, move the mouse, type, and read any window."
const notice = `${Hands.NAME} now does this with per-app asks and a stop key. This plugin can give Vector itself screen access; consider removing it.`
const installed = { "computer-use": { status: "connected" } }

test("the community entry has its new name and Community badge, and points to Hands where the desktop serves it", async ({
  page,
}) => {
  const dialog = await openPlugins(page, { computer: {} })
  const row = dialog.locator('[data-plugin="computer-use"]')
  await expect(row).toContainText(name)
  await expect(row).toContainText("Community")
  await expect(row).toContainText(handsBlurb)
  await expect(row.locator("[data-computer-notice]")).toHaveCount(0)
  await expect(row.getByRole("button", { name: "Connect", exact: true })).toBeVisible()
})

test("an installed copy shows the notice until Dismiss, and it stays dismissed after reopening and reloading", async ({
  page,
}) => {
  const dialog = await openPlugins(page, { computer: {}, mcpStatus: installed })
  const row = dialog.locator('[data-plugin="computer-use"]')
  const message = row.locator("[data-computer-notice]")
  await expect(message).toContainText(notice)
  // Other installed or available rows never get it.
  await expect(dialog.locator("[data-computer-notice]")).toHaveCount(1)
  await message.getByRole("button", { name: "Dismiss", exact: true }).click()
  await expect(message).toHaveCount(0)
  await expect(row).toContainText(handsBlurb)

  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const reopened = await showPlugins(page)
  await expect(remove(reopened, "computer-use")).toBeVisible()
  await expect(reopened.locator("[data-computer-notice]")).toHaveCount(0)

  await page.reload()
  await expectSessionTitle(page, title)
  const reloaded = await showPlugins(page)
  // The reloaded page fetches MCP status again: until it answers, no row is installed and no notice can show.
  await expect(remove(reloaded, "computer-use")).toBeVisible()
  await expect(reloaded.locator("[data-computer-notice]")).toHaveCount(0)
})

test("a company that turns Hands off hides the entry, its notice and its count, and keeps the rest", async ({
  page,
}) => {
  const dialog = await openPlugins(page, {
    computer: {},
    directoryConfig: { computer: { enabled: false } },
    mcpStatus: { ...installed, "chrome-devtools": { status: "connected" } },
  })
  await expect(dialog.locator('[data-plugin="computer-use"]')).toHaveCount(0)
  await expect(dialog.locator("[data-computer-notice]")).toHaveCount(0)
  await expect(remove(dialog, "chrome-devtools")).toBeVisible()
  await expect(dialog.locator('[data-plugin="playwright"]').first()).toBeVisible()
  // Both servers are connected; the hidden copy is left out, so a count of the whole catalog would read 2.
  await expect(dialog).toContainText("1 connected")
})

test("company app rules hide the entry without the desktop, from the server's own policy", async ({ page }) => {
  const dialog = await openPlugins(page, {
    directoryConfig: { computer: { apps: { windows: [{ aumid: "Acme.Ledger_8wekyb3d8bbwe!App", access: "deny" }] } } },
  })
  await expect(dialog.locator('[data-plugin="computer-use"]')).toHaveCount(0)
  await expect(dialog.locator('[data-plugin="chrome-devtools"]')).toBeVisible()
})

test("unrelated company settings keep the entry", async ({ page }) => {
  const dialog = await openPlugins(page, {
    computer: {},
    directoryConfig: { computer: { allow_always: false, background: false, screenshot_retention_days: 1 } },
  })
  await expect(dialog.locator('[data-plugin="computer-use"]')).toContainText(name)
})

test("without Hands an installed entry keeps its neutral blurb and shows no notice", async ({ page }) => {
  const dialog = await openPlugins(page, { mcpStatus: installed })
  const row = dialog.locator('[data-plugin="computer-use"]')
  await expect(remove(dialog, "computer-use")).toBeVisible()
  await expect(row).toContainText(name)
  await expect(row).toContainText(neutralBlurb)
  await expect(row).not.toContainText(Hands.NAME)
  await expect(row).not.toContainText(`@${Hands.MENTION}`)
  await expect(dialog.locator("[data-computer-notice]")).toHaveCount(0)
})

async function openPlugins(
  page: Page,
  input: { computer?: FakeComputerScript } & Pick<MockServerConfig, "directoryConfig" | "mcpStatus">,
) {
  const server: MockServerConfig = {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, title, directory, projectID: project.id, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
    directoryConfig: input.directoryConfig,
    mcpStatus: input.mcpStatus,
    ...(input.computer
      ? { capabilities: { backgroundSubagents: false, computer: { available: true, protocol: 1 } } }
      : {}),
  }
  if (input.computer) await installFakeComputer(page, input.computer, server)
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
  // The directory's config loads in the background, and the entry shows until it has, so a check that the entry
  // stays would pass before it arrives.
  const config = page.waitForResponse((response) => new URL(response.url()).pathname === "/config")
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await (await config).finished()
  return showPlugins(page)
}

async function showPlugins(page: Page) {
  await page.locator('[data-tour="nav-plugins"]').click()
  const dialog = page.getByRole("dialog", { name: "Plugins" })
  // The rows render together, so a present neighbour means an absent entry was left out rather than not drawn yet.
  await expect(dialog.locator('[data-plugin="chrome-devtools"]')).toBeVisible()
  return dialog
}

// A row's Remove button renders only for an installed server, so it also shows that the page's MCP status has
// arrived; an absence checked after it is not just that status still loading.
function remove(dialog: Locator, id: string) {
  return dialog.locator(`[data-plugin="${id}"]`).getByRole("button", { name: "Remove", exact: true })
}
