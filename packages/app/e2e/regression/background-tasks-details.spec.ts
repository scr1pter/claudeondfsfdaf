import { expect, test } from "@playwright/test"
import {
  card,
  child,
  composer,
  openFinished,
  openTasks,
  CREATED,
  posts,
  rootID,
  rootTitle,
  session,
  setup,
  task,
  userMessage,
} from "../utils/multiagent"

// Tasks pane details (5.I.3, 5.I.4): model · effort, the Fork badge and the JSON chip; structured JSON and messages as
// plain text (I13); Answer opens the waiting child; the Talk form for a finished subagent follows controls.resume and
// otherwise asks Vector to continue it with an agent part; a subagent's own page points back to the pane; the limits
// line shows only when the engine sends limits.

const forkID = "ses_fork_audit"
const fork = task({
  id: forkID,
  title: "Audit the error paths",
  agent: "explore",
  model: { providerID: "anthropic", modelID: "haiku-fixture" },
  effort: "low",
  fork: true,
  result: { format: "json", valid: true },
})

test("a row shows model · effort, the Fork badge and the JSON chip, and Details keeps model text as text", async ({
  page,
}) => {
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, workDelegation: true, subagentLimits: true },
    sessions: [child(forkID, "Audit the error paths (@explore subagent)")],
    status: { [forkID]: { type: "busy" } },
    taskList: () => ({ tasks: [fork], truncated: false }),
    taskRoute: (request) =>
      request.action === "inspect"
        ? {
            task: fork,
            steps: [{ tool: "read", status: "completed", text: "Read src/errors.ts" }],
            output: "",
            truncated: false,
            structured: { json: JSON.stringify({ title: "<b>bold</b>", ok: true }), valid: true, truncated: false },
            messages: [
              { id: "msg_1", direction: "to_task", sender: "user", text: "Check the footer too", createdAt: 1 },
              {
                id: "msg_2",
                direction: "to_parent",
                sender: "task",
                text: "<i>Found it</i> in footer.ts",
                createdAt: 2,
              },
              { id: "msg_3", direction: "to_task", sender: "parent", text: "Keep going", createdAt: 3 },
            ],
          }
        : undefined,
  })
  await app.open()
  const panel = await openTasks(page)
  const item = card(panel, "Audit the error paths")
  const row = item.locator("tr.vector-bg-tasks-row").first()
  await expect(row.locator("td").nth(1)).toHaveText("haiku-fixture · low")
  await expect(item.locator('.vector-bg-tasks-badge[data-kind="fork"]')).toHaveText("Fork")
  const chip = item.locator('.vector-bg-tasks-badges .vector-bg-tasks-badge[data-kind="json"]')
  await expect(chip).toHaveText("JSON valid")
  await expect(chip).toHaveAttribute("data-state", "valid")

  await item.getByRole("button", { name: "Details", exact: true }).click()
  const structured = item.locator('pre[data-component="task-structured"]')
  await expect(structured).toContainText('"title": "<b>bold</b>"')
  await expect(structured.locator("b")).toHaveCount(0)
  const messages = item.locator(".vector-bg-tasks-messages li")
  await expect(messages).toHaveCount(3)
  await expect(messages.nth(0).locator(".vector-bg-tasks-sender")).toHaveText("You")
  await expect(messages.nth(1).locator(".vector-bg-tasks-sender")).toHaveText("This subagent")
  await expect(messages.nth(1)).toContainText("<i>Found it</i> in footer.ts")
  await expect(messages.nth(1).locator("i")).toHaveCount(0)
  await expect(messages.nth(2).locator(".vector-bg-tasks-sender")).toHaveText("Main agent")
})

test("Answer opens the waiting child, whose page points back to Background tasks", async ({ page }) => {
  const waitingID = "ses_wait_deploy"
  const waiting = task({
    id: waitingID,
    title: "Check the deploy script",
    status: "waiting_on_user",
    waiting: { kind: "permission", since: Date.now() - 190_000, summary: "Run deploy.sh" },
  })
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, taskAttention: true },
    sessions: [child(waitingID, "Check the deploy script")],
    status: { [waitingID]: { type: "busy" } },
    taskList: () => ({ tasks: [waiting], truncated: false }),
  })
  await app.open()
  const panel = await openTasks(page)
  const item = card(panel, "Check the deploy script")
  const line = item.locator(".vector-bg-tasks-waiting")
  await expect(line).toContainText(/Needs your permission · [34]m/)
  await line.getByRole("button", { name: "Answer", exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/session/${waitingID}$`))
  const notice = page.locator('[data-component="session-child-notice"]')
  await expect(notice).toContainText("This is a subagent. Talk to it from Background tasks.")
  await panel.getByRole("button", { name: "Close background tasks", exact: true }).click()
  await expect(panel).toBeHidden()
  await notice.getByRole("button", { name: "Talk to this subagent", exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(notice.getByRole("button", { name: "Back to main session", exact: true })).toBeVisible()
})

test("the Talk form follows controls.resume and otherwise asks Vector to continue it", async ({ page }) => {
  const resumable = task({
    id: "ses_done_lexer",
    title: "Port the lexer",
    status: "completed",
    controls: { inspect: true, message: false, stop: false, resume: true },
  })
  const finished = task({
    id: "ses_done_footer",
    title: "Audit the footer",
    agent: "explore",
    status: "completed",
    startedAt: Date.now() - 120_000,
  })
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, taskResume: true },
    sessions: [child(resumable.id, "Port the lexer"), child(finished.id, "Audit the footer")],
    messages: { [rootID]: [userMessage(rootID, "msg_0001_user", "Rewrite the parser")] },
    taskList: () => ({ tasks: [resumable, finished], truncated: false }),
    taskRoute: (request) =>
      request.action === "resume"
        ? { tasks: [{ ...resumable, status: "running", completedAt: undefined }] }
        : undefined,
  })
  await app.open()
  const panel = await openTasks(page)

  const lexer = await openFinished(panel, "Port the lexer")
  await lexer.getByRole("button", { name: "Talk to this subagent", exact: true }).click()
  await expect(lexer).toContainText("This subagent has finished. Your message continues it in the background.")
  await lexer.getByLabel("Message Port the lexer", { exact: true }).fill("Also port the comment rules")
  await lexer.getByRole("button", { name: "Continue with this message", exact: true }).click()
  await expect.poll(() => posts(app.capture.tasks, `/experimental/session/${rootID}/tasks/resume`).length).toBe(1)
  expect(posts(app.capture.tasks, `/experimental/session/${rootID}/tasks/resume`)[0]!.body).toEqual({
    taskIDs: [resumable.id],
    text: "Also port the comment rules",
  })

  const footer = await openFinished(panel, "Audit the footer")
  await footer.getByRole("button", { name: "Talk to this subagent", exact: true }).click()
  await expect(footer).toContainText("Vector continues it with the task tool")
  await expect(footer.getByRole("button", { name: "Continue with this message" })).toHaveCount(0)
  await footer.getByRole("button", { name: "Ask Vector to continue it", exact: true }).click()

  const input = composer(page)
  await expect(input).toContainText(
    `Continue "Audit the footer" (task ${finished.id}) with its task_id, using @explore`,
  )
  await expect(input.locator('[data-type="agent"][data-name="explore"]')).toHaveText("@explore")
  await expect(page).toHaveURL(new RegExp(`/session/${rootID}$`))
})

test("the limits line shows the engine's limits, and nothing without them", async ({ page }) => {
  const row = task({ id: "ses_limits_lexer", title: "Port the lexer" })
  let limits: unknown = {
    running: 1,
    queued: 0,
    maxRunning: 8,
    launched: 3,
    maxPerRequest: 32,
    spend: { spentUsd: 3.1, limitUsd: 25, unknownSteps: 0, warned: false, stopped: false },
  }
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, subagentLimits: true },
    sessions: [child(row.id, "Port the lexer")],
    status: { [row.id]: { type: "busy" } },
    taskList: () => ({ tasks: [row], truncated: false, ...(limits ? { limits } : {}) }),
  })
  await app.open()
  const panel = await openTasks(page)
  await expect(panel.locator('[data-component="task-limits"]')).toHaveText(
    "1 of 8 running · 3 of 32 started this request · $3.10 of $25.00 subagent spend",
  )

  // A guest's board (or an older engine's) carries no limits: no line, never invented numbers.
  limits = undefined
  await app.send("session.updated", {
    info: session(rootID, rootTitle, { time: { created: CREATED, updated: Date.now() } }),
  })
  await expect(panel.locator('[data-component="task-limits"]')).toHaveCount(0)
  await expect(card(panel, "Port the lexer")).toBeVisible()
})
