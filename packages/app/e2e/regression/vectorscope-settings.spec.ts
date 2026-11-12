import { expect, test, type Page } from "@playwright/test"
import { reply } from "../utils/mock-server"
import { port, provider, rootID, setup, type Setup } from "../utils/multiagent"

const card = (page: Page) => page.locator('[data-component="vectorscope-settings"]')
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  return settings
}
function engine(extra: Setup = {}): Setup {
  return {
    capabilities: { vectorscopeSettings: true, subagentLimits: true, workDelegation: true },
    globalConfig: {
      experimental: { vectorscope: true },
      agent: {
        review: { model: "generic/reviewer", disable: true },
        vectorscope: { model: "missing/old", variant: "old", disable: false },
      },
    },
    workflow: (request) => (request.action === "saved" ? { workflows: [] } : undefined),
    ...extra,
  }
}
async function catalog(page: Page) {
  const data = provider()
  data.all[0]!.models["maker/text"]!.variants = { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } }
  await page.route(
    (url) => url.port === port && url.pathname === "/provider",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(data),
      }),
  )
}

for (const mode of ["default-off", "old-engine", "guest", "owner-check-error", "owner-check-malformed"] as const)
  test(`VectorScope settings stay hidden for ${mode}`, async ({ page }) => {
    const app = await setup(
      page,
      engine(
        mode === "default-off"
          ? { globalConfig: {} }
          : mode === "old-engine"
            ? { capabilities: { subagentLimits: true } }
            : mode === "guest"
              ? { workflow: () => reply(403, { name: "Forbidden", data: { message: "Owner only" } }) }
              : mode === "owner-check-error"
                ? { workflow: () => reply(500, { name: "UnknownError", data: { message: "Unavailable" } }) }
                : { workflow: () => ({ workflows: "malformed" }) },
      ),
    )
    await app.open()
    const settings = await openSettings(page)
    await expect(settings.getByRole("heading", { name: "Subagents", exact: true })).toBeVisible()
    await expect
      .poll(() => app.capture.workflow.filter((request) => request.path.endsWith("/saved")).length)
      .toBeGreaterThan(0)
    await expect(card(page)).toHaveCount(0)
    expect(app.capture.config).toEqual([])
  })

test("the owner saves a separate model, variant and disable setting only after confirming running work", async ({
  page,
}, info) => {
  const app = await setup(page, engine({ status: { [rootID]: { type: "busy" } } }))
  await catalog(page)
  await app.open()
  await openSettings(page)
  const settings = card(page)
  await expect(settings).toBeVisible()
  await expect(settings.getByRole("button", { name: "VectorScope model", exact: true })).toContainText(
    "Unavailable: missing/old",
  )
  await settings.getByRole("button", { name: "VectorScope model", exact: true }).click()
  await page
    .getByRole("menuitemradio", { name: /Maker Text/ })
    .first()
    .click()
  await expect(settings.getByRole("button", { name: "VectorScope model", exact: true })).toContainText("Maker Text")
  await settings.locator('[data-component="select-v2"]').click()
  await page.getByRole("option", { name: "high", exact: true }).click()
  await settings.getByRole("switch", { name: "Enable VectorScope reviews", exact: true }).click()
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: "Save VectorScope settings?", exact: true })
  await expect(confirm).toBeVisible()
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await confirm.getByRole("button", { name: "Save anyway", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("VectorScope settings saved.")
  expect(app.capture.config).toEqual([
    { agent: { vectorscope: { model: "anthropic/maker/text", variant: "high", disable: true } } },
  ])
  await expect(settings.getByRole("button", { name: "Save VectorScope settings", exact: true })).toBeDisabled()
  await page.screenshot({ path: info.outputPath("vectorscope-settings-saved.png") })
})

test("failed saves retain the draft and retry without showing an unsaved choice as committed", async ({ page }) => {
  const app = await setup(page, engine())
  let failures = 0
  await page.route(
    (url) => url.port === port && url.pathname === "/global/config",
    async (route) => {
      if (route.request().method() !== "PATCH" || failures) return route.fallback()
      failures++
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ name: "UnknownError", data: { message: "The fixture refused the save." } }),
      })
    },
  )
  await app.open()
  await openSettings(page)
  const settings = card(page)
  await settings.getByRole("switch", { name: "Enable VectorScope reviews", exact: true }).click()
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await expect(settings.getByRole("alert")).toBeVisible()
  await expect(settings.getByRole("status")).toHaveCount(0)
  await expect(settings.getByRole("switch", { name: "Enable VectorScope reviews", exact: true })).not.toBeChecked()
  await expect(settings.getByRole("button", { name: "Save VectorScope settings", exact: true })).toBeEnabled()
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("VectorScope settings saved.")
  expect(failures).toBe(1)
  expect(app.capture.config).toHaveLength(1)
})

test("discarding a draft writes nothing and default-model reset clears its variant without enabling reviews", async ({
  page,
}) => {
  const app = await setup(
    page,
    engine({
      globalConfig: {
        experimental: { vectorscope: true },
        agent: { vectorscope: { model: "anthropic/maker/text", variant: "high", disable: true } },
      },
    }),
  )
  await catalog(page)
  await app.open()
  await openSettings(page)
  const settings = card(page)
  await settings.getByRole("button", { name: "Use default model", exact: true }).click()
  await settings.getByRole("button", { name: "Discard changes", exact: true }).click()
  await expect(settings.getByRole("button", { name: "VectorScope model", exact: true })).toContainText("Maker Text")
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Use default model", exact: true }).click()
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("VectorScope settings saved.")
  expect(app.capture.config).toEqual([{ agent: { vectorscope: { model: "", variant: "", disable: true } } }])
})

test("organization-managed VectorScope fields cannot be changed", async ({ page }) => {
  const app = await setup(
    page,
    engine({
      globalConfig: {
        experimental: { vectorscope: true },
        agent: { vectorscope: { model: "anthropic/maker/text" } },
        locked: ["agent.vectorscope.model"],
      },
    }),
  )
  await app.open()
  await openSettings(page)
  await expect(card(page)).toContainText("Your organization manages these settings.")
  await expect(card(page).getByRole("button", { name: "VectorScope model", exact: true })).toBeDisabled()
  await expect(card(page).getByRole("switch", { name: "Enable VectorScope reviews", exact: true })).toBeDisabled()
  expect(app.capture.config).toEqual([])
})
