import { describe, expect, test } from "bun:test"
import type { ParallelWorkspaceRecord } from "./parallel-workspaces"
import type { SwarmRunRecord } from "./swarm-orchestrator"
import { swarmTasks, workspaceTask, workspaceTaskID } from "./agent-task-model"

function workspace(patch: Partial<ParallelWorkspaceRecord> = {}): ParallelWorkspaceRecord {
  return {
    id: "ws_one",
    name: "Implement parser",
    taskPrompt: "Implement parser",
    runtime: "vector",
    provider: "test",
    model: "test-model",
    sourcePath: "/repo",
    parentSessionId: "ses_owner",
    isolatedPath: "/worktrees/one",
    isolation: "git-worktree",
    status: "editing",
    progress: 10,
    lastAction: "Editing parser.ts",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:10Z",
    changedFilesCount: 1,
    riskLevel: "low",
    estimatedCost: "$0.10",
    finalSummary: "",
    mergeState: "none",
    logs: [],
    terminalOutput: [],
    browserResults: [],
    changedFiles: ["parser.ts"],
    diff: "",
    ...patch,
  }
}

function swarm(patch: Partial<SwarmRunRecord> = {}): SwarmRunRecord {
  return {
    id: "sw_one",
    name: "Parser swarm",
    objective: "Implement parser",
    sourcePath: "/repo",
    parentSessionId: "ses_owner",
    strategy: "balanced",
    maxAgents: 4,
    maxConcurrency: 2,
    modelPool: [],
    plannerProvider: "test",
    plannerModel: "test-model",
    status: "running",
    currentStep: "Running workers",
    progress: 10,
    planSummary: "",
    tasks: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:10Z",
    changedFiles: [],
    diff: "",
    riskLevel: "low",
    summary: "",
    logs: [],
    ...patch,
  }
}

describe("shared desktop task observations", () => {
  test("uses measured dollars without inventing token usage or presenting estimates as charges", () => {
    expect(workspaceTask(workspace(), { now: Date.parse("2026-01-01T00:01:00Z") }).measuredCost).toBeUndefined()
    const task = workspaceTask(workspace({ runtime: "claude-code", actualCost: "$0.125" }), { now: Date.now() })
    expect(task.measuredCost).toBe(0.125)
    expect(task.usage).toBeUndefined()
    expect(task.controls.message).toBe(false)
    expect(workspaceTask(workspace({ actualCost: "<$0.01" }), { now: Date.now() }).measuredCost).toBeUndefined()
    expect(
      workspaceTask(workspace({ actualCost: "<$0.01", measuredCost: 0.002 }), { now: Date.now() }).measuredCost,
    ).toBe(0.002)
  })

  test("maps review and terminal states without showing unsupported controls", () => {
    const review = workspaceTask(workspace({ status: "needs review" }), { now: Date.now(), canMessage: true })
    expect(review.status).toBe("waiting_on_user")
    expect(review.controls).toEqual({ inspect: true, message: false, stop: false })
    expect(review.elapsedMs).toBe(10_000)
    expect(workspaceTask(workspace({ status: "discarded" }), { now: Date.now() }).status).toBe("stopped")
  })

  test("keeps team identity and exposes only permitted native steering", () => {
    const task = workspaceTask(workspace({ teamId: "team_one", agentSessionId: "ses_child" }), {
      now: Date.now(),
      canMessage: true,
    })
    expect(task.source).toBe("team")
    expect(task.groupID).toBe("team_one")
    expect(task.sessionID).toBe("ses_child")
    expect(task.controls.message).toBe(true)
  })

  test("swarm tasks retain a stable identity when their workspace is provisioned", () => {
    const run = swarm({
      tasks: [
        {
          id: "task_1",
          title: "Parser",
          prompt: "task",
          role: "implement",
          dependsOn: ["task_0"],
          fileHints: ["parser.ts"],
          provider: "test",
          model: "test-model",
          status: "queued",
          lastAction: "Waiting for a slot",
          changedFilesCount: 0,
          riskLevel: "low",
          summary: "",
        },
      ],
    })
    const planned = swarmTasks(run, Date.now())
    expect(planned).toHaveLength(2)
    expect(planned[1]!.id).toBe("swarm:sw_one:task_1")
    expect(planned[1]!.dependsOn).toEqual(["swarm:sw_one:task_0"])
    expect(planned[1]!.controls.stop).toBe(true)
    expect(
      swarmTasks({ ...run, tasks: run.tasks.map((task) => ({ ...task, workspaceId: "ws_one" })) }, Date.now()),
    ).toHaveLength(2)
    expect(workspaceTaskID(workspace({ swarmRunId: run.id, swarmTaskId: "task_1" }))).toBe(planned[1]!.id)
  })

  test.each([
    ["merging", "needs review", "running", true],
    ["canceled", "complete", "stopped", false],
    ["complete", "discarded", "completed", false],
  ] as const)("projects a %s swarm task from its orchestration state", (status, workspaceStatus, expected, stop) => {
    const run = swarm({
      tasks: [
        {
          id: "task_1",
          title: "Parser",
          prompt: "task",
          role: "implement",
          dependsOn: [],
          fileHints: ["parser.ts"],
          provider: "test",
          model: "test-model",
          status,
          lastAction: "Swarm activity",
          changedFilesCount: 0,
          riskLevel: "low",
          summary: "",
        },
      ],
    })
    const task = workspaceTask(
      workspace({
        status: workspaceStatus,
        swarmRunId: run.id,
        swarmTaskId: "task_1",
        measuredCost: 0.125,
      }),
      { now: Date.now(), swarm: run, canMessage: true },
    )
    expect(task.status).toBe(expected)
    expect(task.controls.stop).toBe(stop)
    expect(task.currentStep).toBe("Swarm activity")
    expect(task.measuredCost).toBe(0.125)
    expect(
      workspaceTask(workspace({ swarmRunId: run.id, swarmTaskId: "task_1" }), {
        now: Date.now(),
        swarm: { ...run, tasks: run.tasks.map((task) => ({ ...task, cancelRequested: true })) },
        canMessage: true,
      }).controls,
    ).toEqual({ inspect: true, message: false, stop: false })
  })
})

test("workspace task billing preserves Codium presence independently of own price classification", () => {
  const now = Date.now()
  const codium = workspaceTask(workspace({ billing: "codium", measuredCost: 0, costKind: "codium" }), { now })
  expect(codium).toMatchObject({ billing: "codium", costKind: "codium", measuredCost: 0 })
  expect(codium.usage).toBeUndefined()
  const mixed = workspaceTask(
    workspace({ provider: "own", billing: "codium", measuredCost: 0.12, actualCost: "$0.12", costKind: "priced" }),
    { now },
  )
  expect(mixed).toMatchObject({ billing: "codium", costKind: "priced", measuredCost: 0.12 })
  expect(mixed.usage).toBeUndefined()
  const unknown = workspaceTask(workspace({ billing: "codium", costKind: "unknown" }), { now })
  expect(unknown).toMatchObject({ billing: "codium", costKind: "unknown" })
  expect(unknown.measuredCost).toBeUndefined()
  expect(unknown.usage).toBeUndefined()
})
