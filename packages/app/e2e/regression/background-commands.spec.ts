import { expect, test } from "@playwright/test"
import type { Task } from "@vectordevai/schema/task"
import { CREATED, openTasks, posts, rootID, rootTitle, session, setup } from "../utils/multiagent"

// Background commands (5.H, 5.I.3): with `backgroundShells` the board asks for `shells=true` and the pane lists the
// root's commands, with Stop for a running one (`task.stop` with its shl_ ID). "Open output" is the desktop's: it opens
// the folder that holds the log on a local server, so the web build shows no such button and never shows the path.

const outputPath = "/home/dev/.local/share/vector/tool-output/shell-shl_dev.log"
const startedAt = Date.now() - 90_000

function commands(): Task.Shell[] {
  return [
    {
      id: "shl_dev",
      title: "bun run dev",
      command: "bun run dev --port 5173",
      status: "running",
      startedAt,
      outputBytes: 2048,
      outputPath,
    },
    {
      id: "shl_test",
      title: "",
      command: "bun test --timeout 30000",
      status: "completed",
      startedAt,
      completedAt: startedAt + 40_000,
      exitCode: 0,
      outputBytes: 512,
    },
  ]
}

test("the Background commands section lists the root's commands, and Stop stops a running one", async ({ page }) => {
  const queries: string[] = []
  let shells = commands()
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, backgroundShells: true },
    taskList: ({ sessionID, query }) => {
      if (sessionID === rootID) queries.push(query.toString())
      return { tasks: [], truncated: false, ...(query.get("shells") === "true" ? { shells } : {}) }
    },
    taskRoute: (request) => {
      if (request.action !== "stop") return undefined
      shells = shells.map((shell) =>
        shell.id === "shl_dev" ? { ...shell, status: "stopped", completedAt: Date.now() } : shell,
      )
      return { tasks: [], shells: shells.filter((shell) => shell.id === "shl_dev") }
    },
  })
  await app.open()
  // The engine's next update of the conversation refreshes the board, as the command's start would.
  await app.send("session.updated", {
    info: session(rootID, rootTitle, { time: { created: CREATED, updated: Date.now() } }),
  })
  const panel = await openTasks(page)
  const section = panel.locator(".vector-bg-tasks-shells")
  await expect(section.getByRole("heading", { name: "Background commands" })).toBeVisible()
  expect(queries.some((query) => new URLSearchParams(query).get("shells") === "true")).toBe(true)

  const dev = section.locator(".vector-bg-tasks-shell").filter({ hasText: "bun run dev" })
  await expect(dev).toHaveAttribute("data-status", "running")
  await expect(dev).toContainText("Running")
  await expect(dev).toContainText("2.0 KB of output")
  const finished = section.locator(".vector-bg-tasks-shell").filter({ hasText: "bun test --timeout 30000" })
  await expect(finished).toContainText("Done")
  await expect(finished).toContainText("exit 0")
  await expect(finished.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)

  // Open output needs the desktop and a local server; the web build never offers it, nor shows the log's path.
  await expect(section.getByRole("button", { name: "Open output" })).toHaveCount(0)
  await expect(section).not.toContainText(outputPath)

  await dev.getByRole("button", { name: "Stop", exact: true }).click()
  const stop = `/experimental/session/${rootID}/tasks/stop`
  await expect.poll(() => posts(app.capture.tasks, stop).length).toBe(1)
  expect(posts(app.capture.tasks, stop)[0]!.body).toEqual({ taskIDs: ["shl_dev"], reason: "Stopped by the user" })
  await expect(dev).toHaveAttribute("data-status", "stopped")
  await expect(dev.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
})

test("an engine without backgroundShells is never asked for commands, and the pane lists none", async ({ page }) => {
  const queries: string[] = []
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true },
    taskList: ({ sessionID, query }) => {
      if (sessionID === rootID) queries.push(query.toString())
      // Commands are listed only for shells=true (I31), which this engine is never asked for.
      return { tasks: [], truncated: false, ...(query.get("shells") === "true" ? { shells: commands() } : {}) }
    },
  })
  await app.open()
  const panel = await openTasks(page)
  await expect.poll(() => queries.length).toBeGreaterThan(0)
  expect(queries.every((query) => new URLSearchParams(query).get("shells") !== "true")).toBe(true)
  await expect(panel.getByText("No background tasks", { exact: true })).toBeVisible()
  await expect(panel.locator(".vector-bg-tasks-shells")).toHaveCount(0)
})
