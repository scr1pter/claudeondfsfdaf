import { expect, test, type Page } from "@playwright/test"
import type { Task } from "@vectordevai/schema/task"
import {
  assistantMessage,
  child,
  directory,
  openFinished,
  openTasks,
  posts,
  rootID,
  setup,
  task,
  userMessage,
  type Setup,
} from "../utils/multiagent"

// A subagent in its own worktree (5.F, 5.I.3): its changed files, Review (route 4) with the patch, Merge (route 5)
// showing Merged, a conflict that never shows Merged, Discard (route 6); and, while it runs, its permission in the
// parent's dock and its parts streaming live, because the engine publishes its events at its home location (4.10).

const isolatedID = "ses_iso_tokenizer"
const branch = "vector/task-ses_iso_tokenizer"
const changed = task({
  id: isolatedID,
  title: "Rewrite the tokenizer",
  status: "completed",
  isolation: { mode: "worktree", state: "changed", branch, files: 2, additions: 14, deletions: 3 },
  controls: { inspect: true, message: false, stop: false, merge: true, discard: true },
})
const patch = [
  "diff --git a/src/tokenizer.ts b/src/tokenizer.ts",
  "--- a/src/tokenizer.ts",
  "+++ b/src/tokenizer.ts",
  "@@ -1,3 +1,4 @@",
  "+export const VERSION = 2",
].join("\n")

function finishedChild(route: Setup["taskRoute"]): Setup {
  let row: Task.Info = changed
  return {
    capabilities: { backgroundSubagents: true, taskIsolation: true },
    sessions: [child(isolatedID, "Rewrite the tokenizer (@general subagent)")],
    taskList: () => ({ tasks: [row], truncated: false }),
    taskRoute: (request) => {
      const result = route?.(request)
      if (request.action === "merge" || request.action === "discard") {
        const next = (result as { task?: Task.Info } | undefined)?.task
        if (next) row = next
      }
      return result
    },
  }
}

async function worktreeRow(page: Page) {
  const item = await openFinished(await openTasks(page), "Rewrite the tokenizer")
  return item.locator(".vector-bg-tasks-worktree")
}

test("an isolated child's changed files open in Review with the patch", async ({ page }) => {
  const app = await setup(
    page,
    finishedChild((request) =>
      request.action === "changes"
        ? {
            task: changed,
            files: [
              { path: "src/tokenizer.ts", status: "modified", additions: 12, deletions: 3, binary: false },
              { path: "src/tokens.ts", status: "added", additions: 2, deletions: 0, binary: false },
            ],
            patch,
            truncated: false,
            mergeable: "clean",
          }
        : undefined,
    ),
  )
  await app.open()
  const worktree = await worktreeRow(page)
  await expect(worktree).toContainText(`Worktree: ${branch} · changed · 2 files changed`)
  await worktree.getByRole("button", { name: "Review", exact: true }).click()

  const files = worktree.locator(".vector-bg-tasks-files li")
  await expect(files).toHaveCount(2)
  await expect(files.nth(0)).toContainText("src/tokenizer.ts")
  await expect(files.nth(0)).toContainText("modified +12 -3")
  await expect(files.nth(1)).toContainText("added +2 -0")
  await expect(worktree.locator('pre[data-component="task-patch"]')).toContainText("+export const VERSION = 2")
  await expect(worktree.getByRole("button", { name: "Hide changes", exact: true })).toBeVisible()
})

test("Merge brings the files in and shows Merged", async ({ page }) => {
  const app = await setup(
    page,
    finishedChild((request) =>
      request.action === "merge"
        ? {
            task: { ...changed, isolation: { mode: "worktree", state: "merged", branch, files: 2 } },
            merged: ["src/tokenizer.ts", "src/tokens.ts"],
            remaining: [],
            conflicts: [],
            checkpoint: "chk_merge",
          }
        : undefined,
    ),
  )
  await app.open()
  const worktree = await worktreeRow(page)
  await worktree.getByRole("button", { name: "Merge", exact: true }).click()
  await worktree.getByRole("button", { name: "Confirm merge", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, /\/tasks\/ses_iso_tokenizer\/merge$/).length).toBe(1)
  await expect(worktree.getByRole("status")).toHaveText("Merged 2 files.")
})

test("a merge that conflicts lists the paths and never shows Merged", async ({ page }) => {
  const app = await setup(
    page,
    finishedChild((request) =>
      request.action === "merge"
        ? {
            task: { ...changed, isolation: { ...changed.isolation!, conflicts: ["src/tokenizer.ts"] } },
            merged: ["src/tokens.ts"],
            remaining: ["src/tokenizer.ts"],
            conflicts: ["src/tokenizer.ts"],
          }
        : undefined,
    ),
  )
  await app.open()
  const worktree = await worktreeRow(page)
  await worktree.getByRole("button", { name: "Merge", exact: true }).click()
  await worktree.getByRole("button", { name: "Confirm merge", exact: true }).click()

  await expect(worktree.locator(".vector-bg-tasks-conflicts")).toContainText("Conflicts: src/tokenizer.ts")
  await page.waitForTimeout(300)
  await expect(worktree.getByText(/^Merged/)).toHaveCount(0)
  await expect(worktree.getByRole("status")).toHaveCount(0)
})

test("Discard removes the worktree's changes", async ({ page }) => {
  const app = await setup(
    page,
    finishedChild((request) =>
      request.action === "discard"
        ? { task: { ...changed, isolation: { mode: "worktree", state: "discarded", branch } } }
        : undefined,
    ),
  )
  await app.open()
  const worktree = await worktreeRow(page)
  await worktree.getByRole("button", { name: "Discard", exact: true }).click()
  await worktree.getByRole("button", { name: "Confirm discard", exact: true }).click()

  await expect.poll(() => posts(app.capture.tasks, /\/tasks\/ses_iso_tokenizer\/discard$/).length).toBe(1)
  await expect(worktree.getByRole("status")).toHaveText("Discarded its changes.")
})

test("an isolated child's permission shows in the parent's dock and its parts stream live", async ({ page }) => {
  const running = task({
    id: isolatedID,
    title: "Rewrite the tokenizer",
    isolation: { mode: "worktree", state: "active", branch },
  })
  const childInfo = child(isolatedID, "Rewrite the tokenizer (@general subagent)")
  const assistant = "msg_0102_child_assistant"
  const textPart = "prt_0102_child_text"
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, taskIsolation: true, taskAttention: true },
    sessions: [childInfo],
    // The engine has not announced the child yet: the root's session list does not hold it.
    unlisted: [isolatedID],
    status: { [rootID]: { type: "busy" }, [isolatedID]: { type: "busy" } },
    messages: {
      [rootID]: [userMessage(rootID, "msg_0001_user", "Rewrite the tokenizer in its own worktree")],
      [isolatedID]: [
        userMessage(isolatedID, "msg_0101_child_user", "Rewrite the tokenizer"),
        assistantMessage(
          isolatedID,
          assistant,
          "msg_0101_child_user",
          [{ id: textPart, type: "text", text: "Reading src/tokenizer.ts" }],
          { completed: false },
        ),
      ],
    },
    taskList: () => ({ tasks: [running], truncated: false }),
  })
  await app.open()

  // Published at its home location (the root's folder), never the worktree's.
  await app.send("session.created", { info: childInfo }, directory)
  await app.send(
    "permission.asked",
    {
      id: "per_iso_edit",
      sessionID: isolatedID,
      permission: "edit",
      patterns: ["src/tokenizer.ts"],
      metadata: {},
      always: [],
    },
    directory,
  )
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(dock).toBeVisible()
  await expect(dock).toContainText("src/tokenizer.ts")
  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/session/${isolatedID}/permissions/per_iso_edit`,
  )
  await dock.getByRole("button", { name: "Allow once", exact: true }).click()
  expect((await reply).postDataJSON()).toEqual({ response: "once" })
  await app.send("permission.replied", { sessionID: isolatedID, requestID: "per_iso_edit" }, directory)
  await expect(dock).toHaveCount(0)

  // Its own page streams the parts as they arrive.
  const panel = await openTasks(page)
  await panel.getByRole("button", { name: /^Open Rewrite the tokenizer/ }).click()
  await expect(page).toHaveURL(new RegExp(`/session/${isolatedID}$`))
  const part = page.locator(`[data-timeline-part-id="${textPart}"]`)
  await expect(part).toContainText("Reading src/tokenizer.ts")
  await app.send(
    "message.part.delta",
    { sessionID: isolatedID, messageID: assistant, partID: textPart, field: "text", delta: " and splitting the lexer" },
    directory,
  )
  await expect(part).toContainText("Reading src/tokenizer.ts and splitting the lexer")
  await app.send(
    "message.part.updated",
    {
      part: {
        id: "prt_0103_child_text",
        sessionID: isolatedID,
        messageID: assistant,
        type: "text",
        text: "The tokenizer now emits spans.",
      },
    },
    directory,
  )
  await expect(page.locator('[data-timeline-part-id="prt_0103_child_text"]')).toContainText(
    "The tokenizer now emits spans.",
  )
})
