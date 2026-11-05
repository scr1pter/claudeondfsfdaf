import { expect, test, type Page } from "@playwright/test"
import { reply } from "../utils/mock-server"
import { rootID, setup, type Setup } from "../utils/multiagent"

// Settings → Agents (5.I.4, B.11): with `subagentLimits` the owner sees the Limits card with the engine's defaults, and
// a save writes `budget.subagents` after asking to stop the running work; an older engine shows "Update this engine";
// a guest sees no card.

async function openAgents(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  return settings
}

function engine(extra: Setup = {}): Setup {
  return {
    capabilities: { backgroundSubagents: true, workDelegation: true, subagentLimits: true, workflows: true },
    globalConfig: {},
    // Work is running, so a save asks first.
    status: { [rootID]: { type: "busy" } },
    workflow: (request) => (request.action === "saved" ? { workflows: [] } : undefined),
    ...extra,
  }
}

test("the owner sees 8, 32 and $25, and saving 4 writes budget.subagents.running after the stop-work dialog", async ({
  page,
}) => {
  const app = await setup(page, engine())
  await app.open()
  const settings = await openAgents(page)
  await expect(settings).toContainText("Up to 8 at once in a conversation and 32 new ones per request")
  await expect(settings).toContainText("$25.00 spend ceiling")

  const limits = settings.locator('[data-component="subagent-limits"]')
  const running = limits.getByLabel("At once")
  await expect(running).toHaveValue("8")
  await expect(limits.getByLabel("Per request")).toHaveValue("32")
  await expect(limits.getByLabel("Spend ceiling (USD)")).toHaveValue("25")

  await running.fill("4")
  await limits.getByRole("button", { name: "Save limits", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Save subagent limits?" })
  await expect(dialog).toContainText("1 session is working right now.")
  expect(app.capture.config).toHaveLength(0)
  await dialog.getByRole("button", { name: "Save anyway", exact: true }).click()

  await expect.poll(() => app.capture.config.length).toBe(1)
  expect(app.capture.config[0]).toEqual({ budget: { subagents: { running: 4, per_request: 32, usd: 25 } } })
  await expect(running).toHaveValue("4")
  await expect(settings).toContainText("Up to 4 at once in a conversation")
})

test("an engine without subagentLimits shows Update this engine and no Limits card", async ({ page }) => {
  const app = await setup(page, engine({ capabilities: { backgroundSubagents: true } }))
  await app.open()
  const settings = await openAgents(page)
  const update = settings.locator('[data-component="subagents-update"]')
  await expect(update).toContainText("Update this engine")
  await expect(update).toContainText("This engine predates 1.99.113.")
  await expect(settings.locator('[data-component="subagent-limits"]')).toHaveCount(0)
  await expect(settings.locator('[data-component="workflow-settings"]')).toHaveCount(0)
})

test("a guest, refused the owner-only route, sees no Limits or Workflows card", async ({ page }) => {
  let probed = false
  const app = await setup(
    page,
    engine({
      workflow: (request) => {
        if (request.action !== "saved") return undefined
        probed = true
        return reply(403, { name: "ForbiddenError", data: { message: "Only the server owner may do this" } })
      },
    }),
  )
  await app.open()
  const settings = await openAgents(page)
  // The facts still say what the engine does; only the owner's settings are hidden.
  await expect(settings).toContainText("Up to 8 at once in a conversation and 32 new ones per request")
  await expect.poll(() => probed).toBe(true)
  await page.waitForTimeout(500)
  await expect(settings.locator('[data-component="subagent-limits"]')).toHaveCount(0)
  await expect(settings.locator('[data-component="workflow-settings"]')).toHaveCount(0)
  await expect(settings.locator('[data-component="subagents-update"]')).toHaveCount(0)
})
