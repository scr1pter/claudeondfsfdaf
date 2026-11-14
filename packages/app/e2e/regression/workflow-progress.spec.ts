import { expect, test } from "@playwright/test"
import type { Task } from "@vectordevai/schema/task"
import {
  assistantMessage,
  card,
  child,
  CREATED,
  openTasks,
  posts,
  rootID,
  rootTitle,
  session,
  setup,
  task,
  userMessage,
} from "../utils/multiagent"

// A workflow run (5.G, 5.I.3): the workflow part in the timeline, one card with a bar per stage that follows the run,
// its agents loaded only when a stage opens (`task.list` on the run), Stop as one `task.stop` with the run ID, and
// Resume only on an engine with the workflows flag.

const runID = "ses_wf_run_parser"
const title = "Review the parser"
const plan = {
  title,
  stages: [
    {
      id: "find",
      title: "Find parser files",
      phase: "map",
      agent: "explore",
      items: "dynamic",
      serial: false,
      writes: "read only",
      asks: [],
    },
    {
      id: "review",
      title: "Review each file",
      phase: "review",
      agent: "general",
      items: 4,
      serial: false,
      writes: "",
      asks: [],
    },
  ],
  maxAgents: 12,
  concurrency: 4,
  steps: 480,
  perAgentSteps: 40,
  minutes: 30,
}

function stages(done: number): Task.WorkflowStage[] {
  return [
    {
      id: "find",
      title: "Find parser files",
      phase: "map",
      total: 4,
      done,
      failed: 0,
      skipped: 0,
      running: 4 - done,
      waiting: 0,
    },
    {
      id: "review",
      title: "Review each file",
      phase: "review",
      total: 4,
      done: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      waiting: 0,
    },
  ]
}

function run(input: { done?: number; status?: Task.Info["status"] } = {}) {
  return task({
    id: runID,
    title: "workflow",
    agent: "workflow",
    status: input.status ?? "running",
    workflow: {
      role: "run",
      runID,
      title,
      stages: stages(input.done ?? 1),
      agents: { launched: 3, max: 12, running: 2 },
    },
  })
}

const agent = task({
  id: "ses_wf_agent_src",
  title: "Find parser files in src",
  agent: "explore",
  parentSessionID: runID,
  groupID: `workflow:${runID}`,
  workflow: { role: "agent", runID, stage: "find", phase: "map", item: "src" },
})

const messages = {
  [rootID]: [
    userMessage(rootID, "msg_0001_user", "Review every parser file"),
    assistantMessage(rootID, "msg_0002_assistant", "msg_0001_user", [
      {
        id: "prt_0002_workflow",
        type: "tool",
        callID: "call_workflow",
        tool: "workflow",
        state: {
          status: "completed",
          input: { title, spec: JSON.stringify({ version: 1, title }) },
          output: JSON.stringify({ runID, title, plan }),
          title,
          metadata: { runID },
          time: { start: 1700000001000, end: 1700000001500 },
        },
      },
    ]),
  ],
}

test("the workflow part shows in the timeline, and the run's stage bars follow its progress", async ({ page }) => {
  let row = run({ done: 1 })
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, workflows: true },
    sessions: [child(runID, title)],
    messages,
    taskList: ({ sessionID }) => ({ tasks: sessionID === rootID ? [row] : [], truncated: false }),
  })
  await app.open()
  const part = page.locator('[data-timeline-part-id="prt_0002_workflow"]')
  await expect(part).toContainText("Workflow")
  await expect(part).toContainText(title)
  await expect(part).toContainText("started")

  const panel = await openTasks(page)
  const item = card(panel, title)
  await expect(item).toContainText("Stages")
  await expect(item).toContainText("3 of 12 agents")
  const find = item.locator(".vector-bg-tasks-phase").filter({ hasText: "Find parser files" })
  await expect(find.locator(".vector-bg-tasks-phase-count")).toHaveText("1/4")
  await expect(find.locator('.vector-bg-tasks-stage-bar [data-part="done"]')).toHaveAttribute("style", /width: 25%/)

  // The run moves on; the engine's next update of the conversation refreshes the board.
  row = run({ done: 3 })
  await app.send("session.updated", {
    info: session(rootID, rootTitle, { time: { created: CREATED, updated: Date.now() } }),
  })
  await expect(find.locator(".vector-bg-tasks-phase-count")).toHaveText("3/4")
  await expect(find.locator('.vector-bg-tasks-stage-bar [data-part="done"]')).toHaveAttribute("style", /width: 75%/)
})

test("opening a stage loads its agents, and Stop posts task.stop with the run ID", async ({ page }) => {
  const listed: string[] = []
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, workflows: true },
    sessions: [child(runID, title)],
    messages,
    taskList: ({ sessionID }) => {
      listed.push(sessionID)
      return { tasks: sessionID === runID ? [agent] : sessionID === rootID ? [run()] : [], truncated: false }
    },
    taskRoute: (request) => (request.action === "stop" ? { tasks: [run({ status: "stopped" })] } : undefined),
  })
  await app.open()
  const panel = await openTasks(page)
  const item = card(panel, title)
  await expect(item).toContainText("Find parser files")
  // Nothing loads the run's agents until a stage opens.
  expect(listed).not.toContain(runID)
  await expect(item.getByRole("button", { name: /^Open Find parser files in src/ })).toHaveCount(0)

  await item.locator(".vector-bg-tasks-phase-toggle").filter({ hasText: "Find parser files" }).click()
  await expect.poll(() => listed.includes(runID)).toBe(true)
  await expect(item.getByRole("button", { name: /^Open Find parser files in src/ })).toBeVisible()

  await item.getByRole("button", { name: `Stop ${title}`, exact: true }).click()
  const stop = `/experimental/session/${rootID}/tasks/stop`
  await expect.poll(() => posts(app.capture.tasks, stop).length).toBe(1)
  // One stop for the run: its agents stop with it.
  expect(posts(app.capture.tasks, stop)[0]!.body).toEqual({ taskIDs: [runID], reason: "Stopped by the user" })
})

for (const workflows of [false, true]) {
  test(`a stopped run ${workflows ? "offers" : "hides"} Resume ${workflows ? "with" : "without"} the workflows flag`, async ({
    page,
  }) => {
    const app = await setup(page, {
      capabilities: { backgroundSubagents: true, workflows },
      sessions: [child(runID, title)],
      messages,
      taskList: ({ sessionID }) => ({
        tasks: sessionID === rootID ? [run({ status: "stopped" })] : [],
        truncated: false,
      }),
    })
    await app.open()
    const panel = await openTasks(page)
    await panel.getByRole("button", { name: /^Finished \d+$/ }).click()
    const item = card(panel, title)
    await item.locator(".vector-bg-tasks-card-toggle").click()
    await expect(item.getByRole("button", { name: "Open results", exact: true })).toBeVisible()
    await expect(item.getByRole("button", { name: "Resume", exact: true })).toHaveCount(workflows ? 1 : 0)
  })
}
