import { expect, test, type Page } from "@playwright/test"
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
const fixture = "/e2e/fixtures/everywhere-settings.html"
const runningNote = "Still running. You can continue it in a new session once it has finished."
const statusEvent = (session: typeof active, status: "busy" | "idle") => ({
  directory: session.directory,
  payload: { type: "session.status", properties: { sessionID: session.id, status: { type: status } } },
})

async function mockJobs(page: Page, events: ReturnType<typeof statusEvent>[] = []) {
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
  return creates
}

const jobRow = (page: Page, title: string) =>
  page.locator('[data-component="settings-everywhere-job"]').filter({ hasText: title })
const continueButton = (page: Page, title: string) =>
  jobRow(page, title).getByRole("button", { name: "Continue in a new session on this branch", exact: true })

test("Everywhere continues only after the mounted row receives an idle status", async ({ page }) => {
  const events = [statusEvent(active, "busy"), statusEvent(idle, "idle")]
  const creates = await mockJobs(page, events)
  await page.goto(fixture)
  await page.getByRole("button", { name: "Show Everywhere settings" }).click()
  await expect(page.getByRole("heading", { name: "Jobs on this computer" })).toBeVisible()

  const activeButton = continueButton(page, active.title)
  const changingButton = continueButton(page, idle.title)
  await expect(activeButton).toBeDisabled()
  await expect(jobRow(page, active.title).getByText(runningNote)).toBeVisible()
  await expect(changingButton).toBeEnabled()
  await activeButton.dispatchEvent("click")

  events.push(statusEvent(idle, "busy"))
  await expect(changingButton).toBeDisabled()
  await expect(jobRow(page, idle.title).getByText(runningNote)).toBeVisible()
  await changingButton.dispatchEvent("click")
  expect(creates).toEqual([])

  events.push(statusEvent(idle, "idle"))
  await expect(changingButton).toBeEnabled()
  await expect(jobRow(page, idle.title).getByText(runningNote)).toHaveCount(0)
  await expect(activeButton).toBeDisabled()
  await changingButton.click()
  await expect(page.getByLabel("Fixture route")).toHaveText(/\/session\/ses_everywhere_continued$/)
  expect(creates).toEqual([{ directory: idle.directory, body: { title: `Continue: ${idle.title}` } }])
})

test("a cold Everywhere panel verifies the scoped job status before continuing", async ({ page }) => {
  const creates = await mockJobs(page)
  const checked: string[] = []
  let answer: "busy" | "unavailable" | "idle" = "busy"
  // The first status read waits until the test has seen the button held while it is in flight.
  let release = () => {}
  let hold: Promise<void> | undefined = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/session\/status(?:\?|$)/, async (route) => {
    const scope = new URL(route.request().url()).searchParams.get("directory")
    if (scope !== active.directory) return route.fallback()
    checked.push(scope)
    const waiting = hold
    hold = undefined
    if (waiting) await waiting
    if (answer === "unavailable") return route.fulfill({ status: 503, json: { message: "Fixture unavailable" } })
    return route.fulfill({ json: answer === "busy" ? { [active.id]: { type: "busy" } } : {} })
  })

  await page.goto(`${fixture}?cold`)
  await page.getByRole("button", { name: "Show Everywhere settings" }).click()
  const button = continueButton(page, active.title)
  await button.click()
  await expect(button).toBeDisabled()
  await button.dispatchEvent("click")
  release()
  await expect(page.getByText(runningNote)).toBeVisible()
  await expect(button).toBeEnabled()
  expect(checked).toEqual([active.directory])
  expect(creates).toEqual([])

  answer = "unavailable"
  await button.click()
  await expect(page.getByText("Vector could not confirm that this job has finished. Try again.")).toBeVisible()
  expect(creates).toEqual([])

  answer = "idle"
  await button.click()
  await expect(page.getByLabel("Fixture route")).toHaveText(/\/session\/ses_everywhere_continued$/)
  expect(checked).toEqual([active.directory, active.directory, active.directory])
  expect(creates).toEqual([{ directory: active.directory, body: { title: `Continue: ${active.title}` } }])
})
