import { expect, test } from "@playwright/test"
import type { Task } from "@vectordevai/schema/task"
import { reply } from "../utils/mock-server"
import { card, child, openFinished, openTasks, posts, rootID, setup, task, type Setup } from "../utils/multiagent"

// Tasks pane controls (5.I.3, 5.I.4): Move to background (route 2), the batch note on an engine without taskPromote,
// Resume for helpers a restart interrupted (route 3) from the dock and the pane, and an isolated child's Merge and
// Discard, each armed by a first click, with the owner-only refusal.

const tasksRoute = (name: string) => `/experimental/session/${rootID}/tasks/${name}`

test("Move to background posts route 2 for the card's foreground subagent", async ({ page }) => {
  let row = task({
    id: "ses_fg_lexer",
    title: "Port the lexer",
    background: false,
    controls: { inspect: true, message: true, stop: true, background: true },
  })
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, taskPromote: true },
    sessions: [child(row.id, "Port the lexer (@general subagent)")],
    status: { [rootID]: { type: "busy" }, [row.id]: { type: "busy" } },
    taskList: () => ({ tasks: [row], truncated: false }),
    taskRoute: (request) => {
      if (request.action !== "background") return undefined
      row = { ...row, background: true, controls: { ...row.controls, background: false } }
      return { tasks: [row] }
    },
  })
  await app.open()
  const panel = await openTasks(page)
  await card(panel, "Port the lexer").getByRole("button", { name: "Move to background", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, tasksRoute("background")).length).toBe(1)
  expect(posts(app.capture.tasks, tasksRoute("background"))[0]!.body).toEqual({ taskIDs: [row.id] })
  await expect(card(panel, "Port the lexer").getByRole("button", { name: "Move to background" })).toHaveCount(0)
})

test("a batch on an engine without taskPromote says why it cannot move", async ({ page }) => {
  const batch = (id: string, title: string) =>
    task({
      id,
      title,
      batchID: "batch_parsers",
      background: false,
      controls: { inspect: true, message: true, stop: true, background: true },
    })
  const rows = [batch("ses_batch_csv", "CSV parser"), batch("ses_batch_json", "JSON parser")]
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true },
    sessions: rows.map((item) => child(item.id, `${item.title} (@general subagent)`)),
    status: Object.fromEntries([rootID, ...rows.map((item) => item.id)].map((id) => [id, { type: "busy" }])),
    taskList: () => ({ tasks: rows, truncated: false }),
  })
  await app.open()
  const panel = await openTasks(page)
  const batchCard = panel.locator("article.vector-bg-tasks-card").filter({ hasText: "CSV parser" })
  await expect(batchCard).toContainText("This engine can move a single subagent, not a batch")
  await expect(batchCard.getByRole("button", { name: "Move to background" })).toHaveCount(0)
  expect(posts(app.capture.tasks, /background$/)).toHaveLength(0)
})

function interruptedSetup(): Setup & { resumed: () => boolean } {
  const at = Date.now() - 120_000
  const interrupted = (id: string, title: string) =>
    task({
      id,
      title,
      status: "stopped",
      interrupted: { at, cause: "shutdown" },
      controls: { inspect: true, message: false, stop: false, resume: true },
    })
  let rows = [interrupted("ses_int_lexer", "Port the lexer"), interrupted("ses_int_docs", "Write the parser docs")]
  let resumed = false
  return {
    resumed: () => resumed,
    capabilities: { backgroundSubagents: true, taskResume: true },
    sessions: rows.map((item) => child(item.id, `${item.title} (@general subagent)`)),
    taskList: () => ({ tasks: rows, truncated: false }),
    taskRoute: (request) => {
      if (request.action !== "resume") return undefined
      resumed = true
      const ids = new Set((request.body as { taskIDs: string[] }).taskIDs)
      rows = rows.map(
        (item): Task.Info =>
          ids.has(item.id)
            ? {
                ...item,
                status: "running",
                completedAt: undefined,
                interrupted: { ...item.interrupted!, resumedAt: Date.now() },
                controls: { inspect: true, message: true, stop: true, resume: false },
              }
            : item,
      )
      return { tasks: rows.filter((item) => ids.has(item.id)) }
    },
  }
}

test("the interrupted dock resumes every interrupted helper through route 3", async ({ page }) => {
  const app = await setup(page, interruptedSetup())
  await app.open()
  const dock = page.locator('[data-component="session-interrupted-dock"]')
  await expect(dock).toContainText("2 subagents stopped when Vector restarted. Nothing resumes on its own.")
  await dock.getByRole("button", { name: "Resume all", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, tasksRoute("resume")).length).toBe(1)
  const body = posts(app.capture.tasks, tasksRoute("resume"))[0]!.body as { taskIDs: string[] }
  expect([...body.taskIDs].sort()).toEqual(["ses_int_docs", "ses_int_lexer"])
  await expect(dock).toHaveCount(0)
})

test("the pane's interrupted section resumes every interrupted helper through route 3", async ({ page }) => {
  const app = await setup(page, interruptedSetup())
  await app.open()
  const panel = await openTasks(page)
  const section = panel.locator(".vector-bg-tasks-interrupted")
  await expect(section.getByRole("heading", { name: "Interrupted when Vector restarted" })).toBeVisible()
  await expect(section).toContainText("Port the lexer")
  await expect(section).toContainText("Write the parser docs")
  await section.getByRole("button", { name: "Resume all (2)", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, tasksRoute("resume")).length).toBe(1)
  const body = posts(app.capture.tasks, tasksRoute("resume"))[0]!.body as { taskIDs: string[] }
  expect([...body.taskIDs].sort()).toEqual(["ses_int_docs", "ses_int_lexer"])
  await expect(section).toHaveCount(0)
})

const isolatedID = "ses_iso_parser"
const isolated = task({
  id: isolatedID,
  title: "Rewrite the tokenizer",
  status: "completed",
  isolation: { mode: "worktree", state: "changed", branch: "vector/task-ses_iso_parser", files: 2 },
  controls: { inspect: true, message: false, stop: false, merge: true, discard: true },
})

function isolatedSetup(route: Setup["taskRoute"]): Setup {
  return {
    capabilities: { backgroundSubagents: true, taskIsolation: true },
    sessions: [child(isolatedID, "Rewrite the tokenizer (@general subagent)")],
    taskList: () => ({ tasks: [isolated], truncated: false }),
    taskRoute: route,
  }
}

test("Merge needs a second click and lists the paths that conflict", async ({ page }) => {
  const app = await setup(
    page,
    isolatedSetup((request) =>
      request.action === "merge"
        ? { task: isolated, merged: ["src/lexer.ts"], remaining: ["src/parser.ts"], conflicts: ["src/parser.ts"] }
        : undefined,
    ),
  )
  await app.open()
  const item = await openFinished(await openTasks(page), "Rewrite the tokenizer")
  const worktree = item.locator(".vector-bg-tasks-worktree")
  await expect(worktree).toContainText("Worktree: vector/task-ses_iso_parser · changed · 2 files changed")

  await worktree.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(worktree.getByRole("button", { name: "Confirm merge", exact: true })).toBeVisible()
  expect(posts(app.capture.tasks, tasksRoute(`${isolatedID}/merge`))).toHaveLength(0)
  await worktree.getByRole("button", { name: "Confirm merge", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, tasksRoute(`${isolatedID}/merge`)).length).toBe(1)
  await expect(worktree.locator(".vector-bg-tasks-conflicts")).toContainText("Conflicts: src/parser.ts")
  await expect(worktree.getByRole("button", { name: "Ask Vector to resolve", exact: true })).toBeVisible()
  await expect(worktree.getByText(/^Merged \d+ files?\.$/)).toHaveCount(0)
})

test("Discard needs a second click", async ({ page }) => {
  const app = await setup(
    page,
    isolatedSetup((request) => (request.action === "discard" ? { task: { ...isolated } } : undefined)),
  )
  await app.open()
  const item = await openFinished(await openTasks(page), "Rewrite the tokenizer")
  const worktree = item.locator(".vector-bg-tasks-worktree")

  await worktree.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(worktree.getByRole("button", { name: "Confirm discard", exact: true })).toBeVisible()
  expect(posts(app.capture.tasks, tasksRoute(`${isolatedID}/discard`))).toHaveLength(0)
  await worktree.getByRole("button", { name: "Confirm discard", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, tasksRoute(`${isolatedID}/discard`)).length).toBe(1)
  expect(posts(app.capture.tasks, tasksRoute(`${isolatedID}/discard`))[0]!.body).toMatchObject({
    reason: "Discarded by the user",
  })
  await expect(worktree).toContainText("Discarded its changes.")
})

test("a merge refused with 403 says only the server owner can merge", async ({ page }) => {
  const app = await setup(
    page,
    isolatedSetup((request) =>
      request.action === "merge"
        ? reply(403, { name: "ForbiddenError", data: { message: "Only the server owner may do this" } })
        : undefined,
    ),
  )
  await app.open()
  const item = await openFinished(await openTasks(page), "Rewrite the tokenizer")
  const worktree = item.locator(".vector-bg-tasks-worktree")
  await worktree.getByRole("button", { name: "Merge", exact: true }).click()
  await worktree.getByRole("button", { name: "Confirm merge", exact: true }).click()

  await expect(worktree.getByRole("alert")).toHaveText(
    "Only the server owner can merge or discard a subagent's worktree.",
  )
  await expect(worktree.getByText(/^Merged/)).toHaveCount(0)
})
