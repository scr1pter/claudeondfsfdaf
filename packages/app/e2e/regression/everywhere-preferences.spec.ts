import { expect, test } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

test("mounted Everywhere settings wait for owner acknowledgement and use the current sidecar revision", async ({
  page,
}) => {
  const directory = "/vector/fixture"
  await mockVectorServer(page, {
    directory,
    project: { id: "fixture", worktree: directory, vcs: "git", name: "Fixture" },
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
    globalConfig: { everywhere: { enabled: true } },
  })
  await page.route(/\/experimental\/session(?:\?|$)/, (route) => route.fulfill({ json: [] }))
  await page.route(/\/experimental\/shell\/unattended(?:\?|$)/, (route) => route.fulfill({ json: {} }))
  await page.route(/\/local(?:\?|$)/, (route) => route.fulfill({ json: { policy: { enabled: false } } }))
  const configWrites: unknown[] = []
  await page.route(/\/global\/config(?:\?|$)/, (route) => {
    if (route.request().method() === "PATCH") configWrites.push(route.request().postDataJSON())
    return route.fallback()
  })
  await page.goto("/e2e/fixtures/everywhere-preferences.html")
  const enable = page.getByRole("button", { name: "Allow this computer to take jobs" })
  const disable = page.getByRole("button", { name: "Stop taking jobs" })
  await expect(enable).toBeEnabled()
  await enable.click()
  await expect(enable).toBeEnabled()
  await expect(disable).toHaveCount(0)
  await enable.click()
  await expect(disable).toBeEnabled()
  await page.getByRole("button", { name: "Choose a folder" }).click()
  await page.getByRole("textbox", { name: "GitHub repository" }).fill("acme/widgets")
  await page.getByRole("button", { name: "Allow this folder" }).click()
  await expect(page.getByText("acme/widgets", { exact: true })).toBeVisible()
  await disable.click()
  await expect(enable).toBeEnabled()

  const writes = await page.evaluate(() => {
    const fixture = (window as Window & { everywherePreferenceFixture?: { writes: unknown[] } })
      .everywherePreferenceFixture
    return fixture?.writes
  })
  expect(writes).toEqual([
    { version: 1, kind: "update", revision: 0, settings: { enabled: true } },
    { version: 1, kind: "update", revision: 0, settings: { enabled: true } },
    {
      version: 1,
      kind: "update",
      revision: 1,
      settings: { enabled: true, projects: [{ directory: "/vector/other", repository: "acme/widgets" }] },
    },
    {
      version: 1,
      kind: "update",
      revision: 2,
      settings: { enabled: false, projects: [{ directory: "/vector/other", repository: "acme/widgets" }] },
    },
  ])
  expect(configWrites).toEqual([])
})
