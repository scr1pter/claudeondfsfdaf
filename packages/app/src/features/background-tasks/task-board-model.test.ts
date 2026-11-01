import { describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import type { Prompt } from "@/context/prompt"
import { taskPartLocations, type TaskAgent } from "./subagent-model"
import {
  appendTaskQuestion,
  mergeTaskBoard,
  taskCost,
  taskSpend,
  stoppableAgents,
  desktopSpendAgents,
} from "./task-board-model"

function observation(input: Partial<Task.Info> = {}): Task.Info {
  return {
    id: "task_a",
    sessionID: "ses_a",
    parentSessionID: "ses_root",
    source: "subagent",
    title: "Inspect routing",
    status: "running",
    startedAt: 100,
    elapsedMs: 25,
    ownedPaths: ["src/router"],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
    ...input,
  }
}

function agent(input: Partial<TaskAgent> = {}): TaskAgent {
  return {
    key: "a",
    sessionID: "ses_a",
    agent: "explore",
    kind: "specialist",
    custom: false,
    label: "Explore",
    title: "Inspect routing",
    status: "running",
    background: true,
    ...input,
  }
}

describe("task board observations", () => {
  test("groups tasks by batch and keeps dependencies and current activity", () => {
    const cards = mergeTaskBoard(
      [],
      [
        observation({ batchID: "batch_1", currentStep: "Reading src/router" }),
        observation({ id: "task_b", sessionID: "ses_b", batchID: "batch_1", status: "queued", dependsOn: ["task_a"] }),
      ],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]!.kindLabel).toBe("Subagent batch")
    expect(cards[0]!.agents[0]!.currentStep).toBe("Reading src/router")
    expect(cards[0]!.agents[1]!.dependsOn).toEqual(["task_a"])
    expect(cards[0]!.agents[1]!.status).toBe("pending")
  })

  test("refreshes status without duplicating the child or losing chip references", () => {
    const prior = mergeTaskBoard([], [observation()])
    prior[0]!.agents[0]!.partID = "part_launch"
    const next = mergeTaskBoard(prior, [observation({ status: "completed", completedAt: 200, resultAvailable: true })])
    expect(next).toHaveLength(1)
    expect(next[0]!.agents).toHaveLength(1)
    expect(next[0]!.status).toBe("done")
    expect(taskPartLocations(next).get("part_launch")?.agent.task?.resultAvailable).toBe(true)
  })

  test("teams and swarms stay separate, and stopped dependencies are terminal", () => {
    const cards = mergeTaskBoard(
      [],
      [
        observation({ source: "team", groupID: "team_a" }),
        observation({
          id: "task_b",
          sessionID: "ses_b",
          source: "swarm",
          groupID: "swarm_a",
          status: "stopped",
          reason: "Dependency failed",
        }),
      ],
    )
    expect(cards.map((card) => card.kindLabel)).toEqual(["Team", "Swarm"])
    expect(cards[1]!.live).toBe(false)
  })
})

describe("task costs", () => {
  test("counts the newest cumulative child usage only once", () => {
    const agents = [agent({ startedAt: 10, cost: 0.5, tokens: 100 }), agent({ startedAt: 20, cost: 0.75, tokens: 150 })]
    expect(taskSpend(agents)).toEqual({ cost: 0.75, tokens: 150, unknown: false, codiumSteps: 0 })
    expect(taskCost(agents)).toBe("$0.75")
  })

  test("unknown external usage is never displayed as free", () => {
    expect(taskCost([agent()])).toBe("Cost unknown")
    expect(taskCost([agent({ cost: 0, unpricedSteps: 1 })])).toBe("Cost unknown")
    expect(taskCost([agent({ cost: 0.04, unpricedSteps: 1 })])).toBe("$0.04 + unpriced usage")
  })
})

test("Ask Vector appends a task question while preserving the existing draft and attachments", () => {
  const prompt: Prompt = [
    { type: "text", content: "Keep this draft", start: 0, end: 15 },
    { type: "image", id: "image_1", filename: "plan.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
  ]
  const next = appendTaskQuestion(prompt, agent())
  expect(next.slice(0, 2)).toEqual(prompt)
  expect(prompt).toHaveLength(2)
  expect(next[2]).toMatchObject({ type: "text", start: 15 })
  expect(next[2]!.type === "text" && next[2]!.content).toContain("task ses_a")
})

test("Stop all sends one swarm coordinator control and keeps unrelated children", () => {
  const root = agent({
    key: "root",
    sessionID: undefined,
    task: observation({ id: "swarm:s", sessionID: undefined, source: "swarm", groupID: "s" }),
  })
  const child = agent({ key: "child", task: observation({ id: "swarm:s:child", source: "swarm", groupID: "s" }) })
  const other = agent({
    key: "other",
    sessionID: "ses_other",
    task: observation({ id: "ses_other", sessionID: "ses_other" }),
  })
  expect(stoppableAgents([root, child, other, other]).map((agent) => agent.key)).toEqual(["root", "other"])
})

test("desktop spend excludes native ledger mirrors and keeps measured dollars separate from tokens", () => {
  const cards = mergeTaskBoard(
    [],
    [
      observation({ id: "workspace:one", sessionID: "ses_one", measuredCost: 0.2 }),
      observation({
        id: "workspace:two",
        sessionID: "ses_two",
        measuredCost: 0.5,
        usage: {
          cost: 0.5,
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          total: 120,
          steps: 1,
          toolUses: 0,
        },
      }),
      observation({ id: "swarm:coordinator", sessionID: undefined, source: "swarm" }),
    ],
  )
  const selected = desktopSpendAgents(cards.flatMap((card) => card.agents))
  expect(selected.map((agent) => agent.task!.id)).toEqual(["workspace:one", "swarm:coordinator"])
  expect(taskSpend(selected)).toEqual({ cost: 0.2, tokens: undefined, unknown: true, codiumSteps: 0 })
})

test("Codium task usage stays separate from priced and unknown own-key work", () => {
  expect(taskCost([agent({ codiumSteps: 3, unpricedSteps: 3, tokens: 0 })])).toBe("Codium")
  expect(taskCost([agent({ codiumSteps: 3, unpricedSteps: 3, tokens: 100, cost: 0.12 })])).toBe("$0.12 + Codium")
  expect(taskCost([agent({ codiumSteps: 3, unpricedSteps: 4, tokens: 100 })])).toBe("Cost unknown + Codium")
})

test("legacy task observations cannot restore raw Codium tokens over a filtered card", () => {
  const usage = { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, steps: 1, toolUses: 0 }
  const cards = mergeTaskBoard([], [observation({ usage: { ...usage, total: 0, codiumSteps: 1, cost: 0.12 } })])
  expect(cards[0]?.agents[0]).toMatchObject({ tokens: 0, codiumSteps: 1 })
  const legacy = mergeTaskBoard(cards, [observation({ usage: { ...usage, total: 100000, cost: 0.12 } })])
  expect(legacy[0]?.agents[0]).toMatchObject({ tokens: 0, codiumSteps: 1, cost: 0.12 })
  expect(taskCost(legacy[0]!.agents)).toBe("$0.12 + Codium")
  const modern = mergeTaskBoard(legacy, [observation({ usage: { ...usage, total: 250, cost: 0.12, codiumSteps: 1 } })])
  expect(modern[0]?.agents[0]).toMatchObject({ tokens: 250, codiumSteps: 1 })
})

test("desktop task observations preserve unknown own spend beside Codium without invented usage", () => {
  const cards = mergeTaskBoard([], [observation({ billing: "codium", costKind: "unknown", measuredCost: 0.12 })])
  expect(cards[0]?.agents[0]).toMatchObject({ codiumSteps: 1, unpricedSteps: 2, cost: 0.12 })
  expect(cards[0]?.agents[0]?.tokens).toBeUndefined()
  expect(taskCost(cards[0]!.agents)).toBe("$0.12 + unpriced usage + Codium")
})

test("guard unknown status survives legacy and modern task usage projections", () => {
  for (const codiumSteps of [undefined, 1]) {
    const cards = mergeTaskBoard(
      [],
      [
        observation({
          billing: "codium",
          costKind: "unknown",
          usage: {
            cost: 0.12,
            total: 100,
            steps: 1,
            toolUses: 0,
            unpricedSteps: 1,
            codiumSteps,
            tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        }),
      ],
    )
    expect(taskCost(cards[0]!.agents)).toBe("$0.12 + unpriced usage + Codium")
  }
})
