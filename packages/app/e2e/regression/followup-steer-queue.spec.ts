import { expect, test, type Page } from "@playwright/test"
import {
  assistantInfo,
  assistantMessage,
  composer,
  posts,
  rootID,
  setup,
  submitButton,
  toast,
  userMessage,
  type Status,
} from "../utils/multiagent"

// Desktop follow-ups (5.I.1): Enter steers the running turn by default, Alt+Enter or the Queue setting holds the
// message, and the queue drains when the turn ends, with the session's page closed, until a run ends badly (I7).

const ASSISTANT = "msg_0002_assistant"
const prompt = `/session/${rootID}/prompt_async`
const dock = (page: Page) => page.locator('[data-component="session-followup-dock"]')

/** The root is mid-turn: its assistant message has not completed. */
function running() {
  return [
    userMessage(rootID, "msg_0001_user", "Rewrite the parser and keep the old tests green"),
    assistantMessage(
      rootID,
      ASSISTANT,
      "msg_0001_user",
      [{ id: "prt_0002_text", type: "text", text: "Reading the parser first." }],
      { completed: false },
    ),
  ]
}

async function busySession(page: Page, settings: Record<string, unknown> = {}) {
  const status: Status = { [rootID]: { type: "busy" } }
  const app = await setup(page, { status: () => status, messages: { [rootID]: running() }, settings })
  await app.open()
  // Stop shows while the turn runs and the composer is empty.
  await expect(submitButton(page)).toHaveAttribute("aria-label", "Stop")
  const idle = async () => {
    status[rootID] = { type: "idle" }
    await app.send("session.status", { sessionID: rootID, status: { type: "idle" } })
  }
  return { app, idle }
}

async function type(page: Page, text: string) {
  await composer(page).click()
  await page.keyboard.type(text)
}

test("Enter steers the running turn through prompt_async and shows no queue dock", async ({ page }) => {
  const { app } = await busySession(page)
  const text = "Also keep the error messages unchanged"
  await type(page, text)
  await expect(submitButton(page)).toHaveAttribute("aria-label", "Send")
  await page.keyboard.press("Enter")

  await expect.poll(() => posts(app.capture.session, prompt).length).toBe(1)
  expect(JSON.stringify(posts(app.capture.session, prompt)[0]!.body)).toContain(text)
  await expect(composer(page)).not.toContainText(text)
  await expect(dock(page)).toHaveCount(0)
})

test("Alt+Enter queues one message while Enter steers", async ({ page }) => {
  const { app } = await busySession(page)
  const text = "Then update the changelog"
  await type(page, text)
  await expect(submitButton(page)).toHaveAttribute("aria-label", "Send")
  await page.keyboard.press("Alt+Enter")

  await expect(dock(page).locator('[data-component="session-followup-row"]')).toContainText(text)
  await expect(composer(page)).not.toContainText(text)
  expect(posts(app.capture.session, prompt)).toHaveLength(0)
})

test("with Queue a message waits, and goes out when the turn ends after the page closed", async ({ page }) => {
  const { app, idle } = await busySession(page, { followup: "queue" })
  const text = "Then run the benchmark again"
  await type(page, text)
  await expect(submitButton(page)).toHaveAttribute("aria-label", "Queue")
  await page.keyboard.press("Enter")

  await expect(dock(page).locator('[data-component="session-followup-row"]')).toContainText(text)
  expect(posts(app.capture.session, prompt)).toHaveLength(0)

  // Home closes the session's page; the queue drains from the window, not the page.
  await page.locator("[data-vector-nav-home]").click()
  await expect(page).toHaveURL(/\/$/)
  expect(posts(app.capture.session, prompt)).toHaveLength(0)

  await idle()
  await expect.poll(() => posts(app.capture.session, prompt).length, { timeout: 15_000 }).toBe(1)
  const body = posts(app.capture.session, prompt)[0]!.body as { messageID?: unknown }
  expect(JSON.stringify(body)).toContain(text)
  // The send carries the ID the queue claimed, so a reload never sends it twice.
  expect(typeof body.messageID).toBe("string")
})

test("a spend-stopped last run pauses the queue until Resume", async ({ page }) => {
  const { app, idle } = await busySession(page, { followup: "queue" })
  const text = "Then summarise what changed"
  await type(page, text)
  await page.keyboard.press("Enter")
  await expect(dock(page).locator('[data-component="session-followup-row"]')).toContainText(text)

  // The run ends in a spend stop, then the session goes idle.
  await app.send("message.updated", {
    info: assistantInfo(rootID, ASSISTANT, "msg_0001_user", {
      error: {
        name: "BudgetStopError",
        data: { reason: "cap", message: "This run reached its $5.00 cap.", spentUsd: 5, capUsd: 5 },
      },
    }),
  })
  await expect(page.locator("[data-budget-stop]").first()).toBeVisible()
  await idle()

  await expect(toast(page, "Queue paused: the last run hit its spend limit")).toBeVisible()
  const paused = page.locator('[data-component="session-followup-paused"]')
  await expect(paused).toContainText("Queue paused: the last run hit its spend limit")
  await page.waitForTimeout(500)
  expect(posts(app.capture.session, prompt)).toHaveLength(0)

  // Resuming accepts how that run ended; the queue sends.
  await paused.getByRole("button", { name: "Resume", exact: true }).click()
  await expect.poll(() => posts(app.capture.session, prompt).length, { timeout: 15_000 }).toBe(1)
  expect(JSON.stringify(posts(app.capture.session, prompt)[0]!.body)).toContain(text)
})

test("a failed drain says so and offers Open session", async ({ page }) => {
  const { idle } = await busySession(page, { followup: "queue" })
  const sent: unknown[] = []
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    sent.push(route.request().postDataJSON())
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ name: "UnknownError", data: { message: "The engine is restarting" } }),
    })
  })
  const text = "Then open a pull request"
  await type(page, text)
  await page.keyboard.press("Enter")
  await expect(dock(page).locator('[data-component="session-followup-row"]')).toContainText(text)

  await page.locator("[data-vector-nav-home]").click()
  await expect(page).toHaveURL(/\/$/)
  await idle()

  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1)
  const failure = toast(page, "A queued message was not sent")
  await expect(failure).toBeVisible()
  await failure.getByRole("button", { name: "Open session", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/session/${rootID}$`))
  const row = dock(page).locator('[data-component="session-followup-row"]')
  await expect(row).toHaveAttribute("data-failed", "")
  await expect(row).toContainText("Not sent")
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible()
  // A failed item waits for Retry; nothing is resent on its own.
  expect(sent).toHaveLength(1)
})
