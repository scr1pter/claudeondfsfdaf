import { expect, test } from "@playwright/test"
import { setup } from "../utils/multiagent"

test("owner Settings installs only the selected release and starts no workflow", async ({ page }) => {
  const app = await setup(page, { capabilities: { subagentLimits: true, backgroundSubagents: true, workflows: true } })
  let installed = false
  const writes: unknown[] = []
  await page.route(/\/experimental\/workflow\/playbooks(?:\/install)?(?:\?|$)/, async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "*" }
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON())
      installed = true
      return route.fulfill({ status: 200, contentType: "application/json", headers,
        body: JSON.stringify({ name: "vector-check", version: "1.0.0" }) })
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers,
      body: JSON.stringify([{ name: "vector-check", version: "1.0.0", sha256: "a".repeat(64), installed, current: installed }]) })
  })
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const library = settings.locator('[data-component="settings-playbooks"]')
  await expect(library).toContainText("vector-check")
  await expect(library).toContainText("Version 1.0.0")
  expect(writes).toEqual([])
  await library.getByRole("button", { name: "Install", exact: true }).click()
  await expect(library.getByRole("button", { name: "Installed", exact: true })).toBeDisabled()
  expect(writes).toEqual([{ name: "vector-check", version: "1.0.0", sha256: "a".repeat(64), replace: false }])
  expect(app.capture.workflow).toEqual([])
})
