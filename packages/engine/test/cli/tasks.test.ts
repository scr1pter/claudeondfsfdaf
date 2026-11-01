import { expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2"
import type { Task } from "@vectordevai/schema/task"
import { executeTaskCommand, formatTasks, tasksForOutput } from "@/cli/cmd/tasks"

test("task CLI uses the owning server and preserves control payloads", async () => {
  const requests: Request[] = []
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    directory: "/fixture/workspace",
    throwOnError: true,
    fetch: async (request) => {
      requests.push(request)
      return Response.json({ tasks: [], truncated: false })
    },
  })
  await executeTaskCommand(client, { action: "list", session: "parent", descendants: true })
  await executeTaskCommand(client, { action: "inspect", session: "parent", taskID: "child" })
  await executeTaskCommand(client, {
    action: "message",
    session: "parent",
    taskID: "child",
    text: "Keep the existing API",
    delivery: "queue",
  })
  await executeTaskCommand(client, {
    action: "stop",
    session: "parent",
    task: ["child", "child", "other"],
    reason: "Requirements changed",
  })
  await executeTaskCommand(client, { action: "wait", session: "parent", taskID: "child", mode: "all", timeout: 100 })
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/experimental/session/parent/tasks"],
    ["GET", "/experimental/session/parent/tasks/child"],
    ["POST", "/experimental/session/parent/tasks/child/message"],
    ["POST", "/experimental/session/parent/tasks/stop"],
    ["POST", "/experimental/session/parent/tasks/wait"],
  ])
  expect(new URL(requests[0].url).searchParams.get("descendants")).toBe("true")
  expect(await requests[2].json()).toEqual({ text: "Keep the existing API", delivery: "queue" })
  expect(await requests[3].json()).toEqual({ taskIDs: ["child", "other"], reason: "Requirements changed" })
  expect(await requests[4].json()).toEqual({ taskIDs: ["child"], mode: "all", timeout: 100 })
})

test("invalid task selections do not send requests", async () => {
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    fetch: async () => {
      throw new Error("unexpected request")
    },
  })
  await expect(executeTaskCommand(client, { action: "stop", session: "parent" })).rejects.toThrow("requires task IDs")
  await expect(
    executeTaskCommand(client, { action: "stop", session: "parent", all: true, taskID: "child" }),
  ).rejects.toThrow("Choose --all")
  await expect(
    executeTaskCommand(client, { action: "message", session: "parent", taskID: "child", text: "  " }),
  ).rejects.toThrow("non-empty text")
  await expect(
    executeTaskCommand(client, { action: "wait", session: "parent", taskID: "child", timeout: Infinity }),
  ).rejects.toThrow("timeout must be")
})

test("task CLI never renders missing usage as zero spend", () => {
  expect(formatTasks([])).toBe("No subagent tasks.")
  const task: Task.Info = {
    id: "child",
    parentSessionID: "parent",
    source: "subagent",
    title: "Work",
    status: "running",
    startedAt: 1,
    elapsedMs: 1,
    ownedPaths: [],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
  }
  const usage = {
    cost: 0.12,
    total: 987654,
    steps: 2,
    toolUses: 0,
    unpricedSteps: 1,
    tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const legacy = { ...task, billing: "codium" as const, costKind: "unknown" as const, usage }
  for (const result of [
    { tasks: [legacy], truncated: false },
    { task: legacy, steps: [], truncated: false },
    { tasks: [legacy], timedOut: false },
  ]) {
    const printed = JSON.stringify(tasksForOutput(result))
    expect(printed).not.toContain("987654")
    expect(printed).toContain('"cost":0.12')
    expect(printed).toContain('"costKind":"unknown"')
  }
  const modern = {
    ...legacy,
    usage: { ...usage, tokensOwnOnly: true, codiumSteps: 1, total: 123, tokens: { ...usage.tokens, input: 123 } },
  }
  expect(tasksForOutput({ tasks: [modern, task], truncated: false })).toEqual({
    tasks: [modern, task],
    truncated: false,
  })
  for (const codiumSteps of [0, 1]) {
    const ambiguous = { ...task, usage: { ...usage, codiumSteps } }
    expect(JSON.stringify(tasksForOutput({ task: ambiguous }))).not.toContain("987654")
    expect(formatTasks([ambiguous])).not.toContain("987,654")
    expect(formatTasks([ambiguous])).toContain("$0.1200")
  }
  expect(legacy.usage.total).toBe(987654)
  expect(formatTasks([task])).toContain("usage unavailable")
  expect(formatTasks([{ ...task, billing: "codium", costKind: "codium" }])).toContain("Codium")
  const mixed = formatTasks([{ ...task, billing: "codium", costKind: "unknown", measuredCost: 0.12 }])
  expect(mixed).toContain("$0.1200 reported + unpriced + Codium")
  expect(mixed).not.toContain("tokens")
  expect(formatTasks([{ ...task, connection: "disconnected" }])).toContain("disconnected (last known: running)")
  expect(formatTasks([{ ...task, source: "external", measuredCost: 0.125, costKind: "priced" }])).toContain(
    "$0.1250 reported · tokens unavailable",
  )
  expect(formatTasks([{ ...task, source: "external", costKind: "plan" }])).toContain(
    "covered by plan · tokens unavailable",
  )
})
