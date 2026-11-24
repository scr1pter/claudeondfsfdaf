import { expect, test } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

const directory = "/vector/fixture"
const job = (id: string, title: string, updated: number, jid: string) => ({
  id,
  title,
  directory: `/data/everywhere-worktree/fixture/${id}`,
  projectID: "fixture",
  time: { created: 1, updated },
  metadata: { "vector.unattended": { by: "everywhere", jid, platform: "slack" } },
})
const active = job("ses_everywhere_active", "Initially active job", 2, "vej_0000000000abcdefghjkmn")
const idle = job("ses_everywhere_idle", "Job changing status", 1, "vej_0000000000abcdefghjkmp")
const statusEvent = (session: typeof active, status: "busy" | "idle") => ({
  directory: session.directory,
  payload: { type: "session.status", properties: { sessionID: session.id, status: { type: status } } },
})

test("Everywhere continues only after the mounted row receives an idle status", async ({ page }) => {
  const events = [statusEvent(active, "busy"), statusEvent(idle, "idle")]
  const creates: { directory: string | null; body: unknown }[] = []
  await mockVectorServer(page, {
    directory,
    project: { id: "fixture", worktree: directory, vcs: "git", name: "Fixture" },
    provider: { all: [], connected: [], default: {} },
    sessions: [active, idle],
    pageMessages: () => ({ items: [] }),
    globalConfig: { everywhere: { enabled: true } },
    events: () => events.splice(0),
    eventRetry: 50,
  })
  await page.route(/\/experimental\/session(?:\?|$)/, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: [active, idle] }) : route.fallback(),
  )
  await page.route(/\/experimental\/shell\/unattended(?:\?|$)/, (route) => route.fulfill({ json: {} }))
  await page.route(/\/local(?:\?|$)/, (route) => route.fulfill({ json: { policy: { enabled: false } } }))
  await page.route(/\/session(?:\?|$)/, (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== "POST" || url.pathname !== "/session") return route.fallback()
    creates.push({ directory: url.searchParams.get("directory"), body: request.postDataJSON() })
    return route.fulfill({ json: { id: "ses_everywhere_continued" } })
  })
  await page.goto("/e2e/fixtures/everywhere-settings.html")
  await page.getByRole("button", { name: "Show Everywhere settings" }).click()
  await expect(page.getByRole("heading", { name: "Jobs on this computer" })).toBeVisible()

  const row = (title: string) => page.locator('[data-component="settings-everywhere-job"]').filter({ hasText: title })
  const continueButton = (title: string) =>
    row(title).getByRole("button", { name: "Continue in a new session on this branch", exact: true })
  const runningNote = "Still running. You can continue it in a new session once it has finished."
  const activeButton = continueButton(active.title)
  const changingButton = continueButton(idle.title)
  await expect(activeButton).toBeDisabled()
  await expect(row(active.title).getByText(runningNote)).toBeVisible()
  await expect(changingButton).toBeEnabled()
  await activeButton.dispatchEvent("click")

  events.push(statusEvent(idle, "busy"))
  await expect(changingButton).toBeDisabled()
  await expect(row(idle.title).getByText(runningNote)).toBeVisible()
  await changingButton.dispatchEvent("click")
  expect(creates).toEqual([])

  events.push(statusEvent(idle, "idle"))
  await expect(changingButton).toBeEnabled()
  await expect(row(idle.title).getByText(runningNote)).toHaveCount(0)
  await expect(activeButton).toBeDisabled()
  await changingButton.click()
  await expect(page.getByLabel("Fixture route")).toHaveText(/\/session\/ses_everywhere_continued$/)
  expect(creates).toEqual([{ directory: idle.directory, body: { title: `Continue: ${idle.title}` } }])
})
