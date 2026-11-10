import { describe, expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import type { Prompt } from "@/context/prompt"
import { taskPartLocations, type TaskAgent } from "./subagent-model"
import {
  appendTaskConflicts,
  appendTaskContinuation,
  appendTaskQuestion,
  mergeTaskBoard,
  promotableAgents,
  promotesBatch,
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
  const cards = mergeTaskBoard(
    [],
    [observation({ usage: { ...usage, tokensOwnOnly: true, total: 0, codiumSteps: 1, cost: 0.12 } })],
  )
  expect(cards[0]?.agents[0]).toMatchObject({ tokens: 0, codiumSteps: 1 })
  const legacy = mergeTaskBoard(cards, [observation({ usage: { ...usage, total: 100000, cost: 0.12 } })])
  expect(legacy[0]?.agents[0]).toMatchObject({ tokens: 0, codiumSteps: 1, cost: 0.12 })
  expect(taskCost(legacy[0]!.agents)).toBe("$0.12 + Codium")
  const modern = mergeTaskBoard(legacy, [
    observation({ usage: { ...usage, tokensOwnOnly: true, total: 250, cost: 0.12, codiumSteps: 1 } }),
  ])
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

test("task aggregate requires proof even with no surviving Codium identity or with a later counter", () => {
  for (const codiumSteps of [0, 1]) {
    const usage = {
      tokens: { input: 987654, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      total: 987654,
      steps: 1,
      toolUses: 0,
      cost: 0.12,
      codiumSteps,
    }
    const cards = mergeTaskBoard([], [observation({ usage })])
    expect(cards[0]?.agents[0]?.tokens).toBeUndefined()
    expect(cards[0]?.agents[0]?.cost).toBe(0.12)
    const next = mergeTaskBoard(cards, [observation({ usage: { ...usage, tokensOwnOnly: true, total: 123 } })])
    expect(next[0]?.agents[0]?.tokens).toBe(123)
  }
})

describe("1.99.113 board fields", () => {
  test("model, effort, fork, result, isolation, queued reason, waiting and interruption reach the agent", () => {
    const cards = mergeTaskBoard(
      [],
      [
        observation({
          status: "queued",
          model: { providerID: "anthropic", modelID: "claude-opus-5", variant: "high" },
          effort: "high",
          fork: true,
          queuedReason: "Waiting for a free subagent slot",
          result: { format: "json", valid: false, attempts: 2 },
          isolation: {
            mode: "worktree",
            state: "changed",
            branch: "vector/task-ses_a",
            files: 3,
            directory: "/secret",
          },
          interrupted: { at: 50, cause: "shutdown", reported: true },
        }),
      ],
      { modelName: (providerID, modelID) => (modelID === "claude-opus-5" ? "Claude Opus 5" : undefined) },
    )
    const agent = cards[0]!.agents[0]!
    expect(agent.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5",
      variant: "high",
      name: "Claude Opus 5",
      short: "Opus 5",
    })
    expect(agent).toMatchObject({
      effort: "high",
      fork: true,
      queuedReason: "Waiting for a free subagent slot",
      result: { format: "json", valid: false, attempts: 2 },
      isolation: { mode: "worktree", state: "changed", branch: "vector/task-ses_a", files: 3 },
      interrupted: { at: 50, cause: "shutdown" },
    })
    // The pane never holds the worktree's directory, even when an owner's board carries it.
    expect(agent.isolation && "directory" in agent.isolation).toBe(false)
  })

  test("a row that moved on clears its queued reason and waiting, and keeps what the part said otherwise", () => {
    const queued = mergeTaskBoard(
      [],
      [observation({ status: "queued", queuedReason: "Waiting for a free subagent slot" })],
    )
    const waiting = mergeTaskBoard(queued, [
      observation({ status: "waiting_on_user", waiting: { kind: "permission", since: 10, requestID: "per_1" } }),
    ])
    expect(waiting[0]!.agents[0]!.queuedReason).toBeUndefined()
    expect(waiting[0]!.agents[0]!.waiting).toMatchObject({ kind: "permission", since: 10 })
    const running = mergeTaskBoard(waiting, [observation({ status: "running" })])
    expect(running[0]!.agents[0]!.waiting).toBeUndefined()

    const part = agent({ effort: "low", fork: true, result: { format: "json", valid: true } })
    const legacy = mergeTaskBoard([{ ...mergeTaskBoard([], [observation()])[0]!, agents: [part] }], [observation()])
    expect(legacy[0]!.agents[0]).toMatchObject({ effort: "low", fork: true, result: { format: "json", valid: true } })
  })

  test("background follows task.background, and an engine that predates it lists background work", () => {
    const [foreground] = mergeTaskBoard([], [observation({ background: false })])
    expect(foreground!.agents[0]!.background).toBe(false)
    const [background] = mergeTaskBoard([], [observation({ background: true })])
    expect(background!.agents[0]!.background).toBe(true)
    const [older] = mergeTaskBoard([], [observation()])
    expect(older!.agents[0]!.background).toBe(true)
  })
})

describe("workflow runs", () => {
  const run = (input: Partial<Task.Info> = {}) =>
    observation({
      id: "ses_run",
      sessionID: "ses_run",
      title: "workflow",
      agent: "workflow",
      usage: {
        cost: 2,
        tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        total: 1000,
        steps: 4,
        toolUses: 2,
        tokensOwnOnly: true,
      },
      workflow: {
        role: "run",
        runID: "ses_run",
        title: "Audit the routes",
        stages: [
          { id: "scan", title: "Scan", phase: "", total: 2, done: 1, failed: 0, skipped: 0, running: 1, waiting: 0 },
        ],
      },
      ...input,
    })
  const step = (id: string, input: Partial<Task.Info> = {}) =>
    observation({
      id,
      sessionID: id,
      parentSessionID: "ses_run",
      groupID: "workflow:ses_run",
      usage: {
        cost: 1,
        tokens: { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        total: 500,
        steps: 2,
        toolUses: 1,
        tokensOwnOnly: true,
      },
      workflow: { role: "agent", runID: "ses_run", stage: "scan", phase: "", item: id },
      ...input,
    })

  test("a run and its loaded agents are one card under one key, labelled Workflow and titled by the run", () => {
    const cards = mergeTaskBoard([], [step("ses_w1"), run(), step("ses_w2", { status: "completed" })])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      key: "subagent:workflow:ses_run",
      kindLabel: "Workflow",
      title: "Audit the routes",
    })
    expect(cards[0]!.runID).toBe("ses_run")
    expect(cards[0]!.agents.map((agent) => agent.task!.id).sort()).toEqual(["ses_run", "ses_w1", "ses_w2"])
    // The run row alone, before any agent is loaded, keys the same card.
    expect(mergeTaskBoard([], [run()])[0]!.key).toBe("subagent:workflow:ses_run")
  })

  test("Stop sends one control for the run, never one per agent", () => {
    const cards = mergeTaskBoard([], [run(), step("ses_w1"), step("ses_w2")])
    expect(stoppableAgents(cards[0]!.agents).map((agent) => agent.task!.id)).toEqual(["ses_run"])
    // Agents whose run is not listed are their own scope.
    expect(stoppableAgents(mergeTaskBoard([], [step("ses_w1")])[0]!.agents).map((agent) => agent.task!.id)).toEqual([
      "ses_w1",
    ])
  })

  test("the run's usage already includes its agents', so the card counts it once", () => {
    const cards = mergeTaskBoard([], [run(), step("ses_w1"), step("ses_w2")])
    expect(taskSpend(cards[0]!.agents)).toMatchObject({ cost: 2, tokens: 1000, unknown: false })
    expect(taskCost(cards[0]!.agents)).toBe("$2.00")
  })
})

describe("continuing, resolving and moving to the background", () => {
  test("Ask Vector to continue it adds the title as JSON, the task ID and an agent part for its subagent type", () => {
    const prompt: Prompt = [{ type: "text", content: "Keep this draft", start: 0, end: 15 }]
    const quoted = agent({ title: 'Fix "routing" <b>now</b>', agent: "explore", task: observation({ id: "ses_a" }) })
    const next = appendTaskContinuation(prompt, quoted, "and add tests")
    expect(next[0]).toEqual(prompt[0]!)
    const lead = next[1]!
    expect(lead.type === "text" && lead.content).toContain(JSON.stringify('Fix "routing" <b>now</b>'))
    expect(lead.type === "text" && lead.content).toContain("(task ses_a)")
    expect(lead).toMatchObject({ start: 15 })
    expect(next[2]).toEqual({
      type: "agent",
      name: "explore",
      content: "@explore",
      start: lead.type === "text" ? lead.end : -1,
      end: (lead.type === "text" ? lead.end : 0) + "@explore".length,
    })
    expect(next[3]).toMatchObject({
      type: "text",
      content: ": and add tests",
      start: next[2]!.type === "agent" ? next[2]!.end : -1,
    })
    // An empty composer starts the text at 0 with no blank line.
    const fresh = appendTaskContinuation([], quoted)
    expect(fresh[0]).toMatchObject({ type: "text", start: 0 })
    expect(fresh[0]!.type === "text" && fresh[0]!.content.startsWith("Continue ")).toBe(true)
  })

  test("Ask Vector to resolve names the conflicting paths as JSON", () => {
    const next = appendTaskConflicts([], agent({ task: observation({ id: "ses_a" }) }), ["src/a.ts", "src/b.ts"])
    expect(next[0]!.type === "text" && next[0]!.content).toContain('["src/a.ts","src/b.ts"]')
    expect(next[0]!.type === "text" && next[0]!.content).toContain("task ses_a")
  })

  test("only the root's own running foreground children that the engine offers can move", () => {
    const offered = agent({
      task: observation({ controls: { inspect: true, message: true, stop: true, background: true } }),
    })
    const nested = agent({
      key: "n",
      sessionID: "ses_n",
      task: observation({
        id: "ses_n",
        parentSessionID: "ses_a",
        controls: { inspect: true, message: true, stop: true, background: true },
      }),
    })
    const plain = agent({ key: "p", sessionID: "ses_p", task: observation({ id: "ses_p" }) })
    const finished = agent({
      key: "f",
      status: "done",
      task: observation({ id: "ses_f", controls: { inspect: true, message: false, stop: false, background: true } }),
    })
    expect(promotableAgents([offered, nested, plain, finished, offered], "ses_root")).toEqual([offered])
    expect(promotableAgents([offered], undefined)).toEqual([])
    expect(promotesBatch([offered])).toBe(false)
    expect(promotesBatch([agent({ task: observation({ batchID: "batch_1" }) })])).toBe(true)
    expect(promotesBatch([offered, plain])).toBe(true)
  })
})
