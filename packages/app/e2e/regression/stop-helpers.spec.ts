import { expect, test, type Page } from "@playwright/test"
import { reply } from "../utils/mock-server"
import {
  assistantMessage,
  child,
  composer,
  posts,
  rootID,
  setup,
  submitButton,
  task,
  toast,
  userMessage,
  type Setup,
} from "../utils/multiagent"

// Stop while helpers run (5.I.2): plain Stop is the unchanged abort, the chevron offers "Stop including helpers (N)"
// (route 1), a toast after a main-only stop offers "Stop them too", an engine without the flags falls back to aborting
// each helper's session, and the Stop button setting makes Esc stop the helpers too.

const helperID = "ses_helper_search"
const helper = task({ id: helperID, title: "Search the parser tests", status: "running", background: true })
const stopRoute = `/experimental/session/${rootID}/stop`
const abort = (sessionID: string) => `/session/${sessionID}/abort`
const FLAGS = { backgroundSubagents: true, sessionStop: true, taskResume: true }

function helpersSession(extra: Setup = {}): Setup {
  return {
    capabilities: FLAGS,
    sessions: [child(helperID, "Search the parser tests (@general subagent)")],
    status: { [rootID]: { type: "busy" }, [helperID]: { type: "busy" } },
    messages: { [rootID]: [userMessage(rootID, "msg_0001_user", "Rewrite the parser")] },
    taskList: () => ({ tasks: [helper], truncated: false }),
    taskRoute: (request) =>
      request.action === "session.stop"
        ? { aborted: true, tasks: [{ ...helper, status: "stopped" }], shells: 0, excluded: 0, skipped: 0 }
        : undefined,
    ...extra,
  }
}

const menu = (page: Page) => page.getByRole("button", { name: "Choose what to stop", exact: true })

test("the Stop chevron offers both scopes and Stop including helpers posts route 1", async ({ page }) => {
  const app = await setup(page, helpersSession())
  await app.open()
  await expect(submitButton(page)).toHaveAttribute("aria-label", "Stop")
  await menu(page).click()
  await expect(page.getByRole("menuitem", { name: "Stop the main turn" })).toBeVisible()
  await page.getByRole("menuitem", { name: /Stop including helpers \(1\)/ }).click()

  await expect.poll(() => posts(app.capture.tasks, stopRoute).length).toBe(1)
  expect(posts(app.capture.tasks, stopRoute)[0]!.body).toMatchObject({ helpers: true })
  // Route 1 aborts the main turn on the engine; the app sends no separate abort.
  expect(posts(app.capture.session, abort(rootID))).toHaveLength(0)
})

test("plain Stop posts only the abort, then offers Stop them too", async ({ page }) => {
  const app = await setup(page, helpersSession())
  await app.open()
  await expect(menu(page)).toBeVisible()
  await submitButton(page).click()

  await expect.poll(() => posts(app.capture.session, abort(rootID)).length).toBe(1)
  const left = toast(page, "Main turn stopped. 1 helper is still working.")
  await expect(left).toBeVisible()
  await expect(left.getByRole("button", { name: "Show tasks", exact: true })).toBeVisible()
  expect(posts(app.capture.tasks, stopRoute)).toHaveLength(0)
  expect(posts(app.capture.tasks, /\/tasks\/stop$/)).toHaveLength(0)

  await left.getByRole("button", { name: "Stop them too", exact: true }).click()
  await expect.poll(() => posts(app.capture.tasks, stopRoute).length).toBe(1)
  expect(posts(app.capture.tasks, stopRoute)[0]!.body).toMatchObject({ helpers: true })
  // The main turn was already stopped.
  expect(posts(app.capture.session, abort(rootID))).toHaveLength(1)
})

test("an engine that answers 404 for its capabilities falls back to aborting each helper", async ({ page }) => {
  // An engine before the capabilities route: no flags, no task rows. The helper is known from the transcript.
  const app = await setup(page, {
    capabilities: reply(404, { name: "NotFoundError", data: { message: "Not found" } }),
    sessions: [child(helperID, "Search the parser tests (@general subagent)")],
    status: { [rootID]: { type: "busy" }, [helperID]: { type: "busy" } },
    messages: {
      [rootID]: [
        userMessage(rootID, "msg_0001_user", "Rewrite the parser"),
        assistantMessage(
          rootID,
          "msg_0002_assistant",
          "msg_0001_user",
          [
            {
              id: "prt_0002_task",
              type: "tool",
              callID: "call_search",
              tool: "task",
              state: {
                status: "completed",
                input: { description: "Search the parser tests", subagent_type: "general" },
                output: "Background task started",
                title: "Search the parser tests",
                metadata: { sessionId: helperID, status: "running", background: true },
                time: { start: 1700000001000, end: 1700000001500 },
              },
            },
          ],
          { completed: false },
        ),
      ],
    },
  })
  await app.open()
  await menu(page).click()
  await page.getByRole("menuitem", { name: /Stop including helpers \(1\)/ }).click()

  await expect.poll(() => posts(app.capture.session, abort(helperID)).length).toBe(1)
  expect(posts(app.capture.session, abort(rootID))).toHaveLength(1)
  expect(posts(app.capture.tasks, /.*/)).toHaveLength(0)
})

test("with the Stop button set to include helpers, Esc stops them through route 1", async ({ page }) => {
  const app = await setup(page, helpersSession({ settings: { stopScope: "all" } }))
  await app.open()
  await expect(menu(page)).toBeVisible()
  await composer(page).click()
  await page.keyboard.press("Escape")

  await expect.poll(() => posts(app.capture.tasks, stopRoute).length).toBe(1)
  expect(posts(app.capture.tasks, stopRoute)[0]!.body).toMatchObject({ helpers: true })
  expect(posts(app.capture.session, abort(rootID))).toHaveLength(0)
})
