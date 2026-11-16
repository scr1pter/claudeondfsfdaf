import { describe, expect, test } from "bun:test"
import {
  agentCardDetails,
  agentCostLabel,
  boardColumns,
  directoryReviewTarget,
  elapsedLabel,
  filterAgents,
  hasActiveFilters,
  isDirected,
  orderConversation,
  findClashes,
  groupAgents,
  isFinished,
  isRunning,
  needsAttention,
  sortForDisplay,
  summarize,
  type DashboardAgentInput,
} from "./agent-dashboard-model"

let counter = 0
function agent(partial: Partial<DashboardAgentInput> = {}): DashboardAgentInput {
  counter += 1
  return {
    id: `agent-${counter}`,
    name: `Agent ${counter}`,
    taskPrompt: "do the thing",
    runtime: "vector",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "editing",
    progress: 40,
    lastAction: "editing src/index.ts",
    createdAt: "2026-08-15T20:00:00.000Z",
    lastActivityAt: "2026-08-15T20:05:00.000Z",
    changedFilesCount: 1,
    changedFiles: ["src/index.ts"],
    estimatedCost: "$0.10",
    mergeState: "none",
    ...partial,
  }
}

test("workspace review uses only a settled native checkout and its real base commit", () => {
  const selected = agent({
    id: "workspace",
    status: "complete",
    isolatedPath: "/fixture/isolated",
    baseCommit: "a".repeat(40),
  })
  expect(directoryReviewTarget(selected)).toEqual({
    workspaceID: selected.id,
    directory: selected.isolatedPath!,
    base: selected.baseCommit!,
  })
  expect(directoryReviewTarget({ ...selected, baseCommit: undefined })).toBeUndefined()
  expect(directoryReviewTarget({ ...selected, isolatedPath: undefined })).toBeUndefined()
  expect(directoryReviewTarget({ ...selected, isolatedPath: "relative/folder" })).toBeUndefined()
  expect(directoryReviewTarget({ ...selected, status: "editing" })).toBeUndefined()
  expect(directoryReviewTarget({ ...selected, mergeState: "merged" })).toBeUndefined()
})

describe("status predicates", () => {
  test("classifies running, finished, and attention states", () => {
    expect(isRunning("editing")).toBe(true)
    expect(isRunning("complete")).toBe(false)
    expect(isFinished("merged")).toBe(true)
    expect(isFinished("needs review")).toBe(false)
    expect(needsAttention(agent({ status: "failed" }))).toBe(true)
    expect(needsAttention(agent({ status: "needs review" }))).toBe(true)
    expect(needsAttention(agent({ status: "editing", error: "boom" }))).toBe(true)
    expect(needsAttention(agent({ status: "editing" }))).toBe(false)
  })
})

describe("findClashes", () => {
  test("reports two live agents holding the same file", () => {
    const clashes = findClashes([
      agent({ name: "Alpha", changedFiles: ["src/a.ts", "src/shared.ts"] }),
      agent({ name: "Beta", changedFiles: ["src/b.ts", "src/shared.ts"] }),
    ])
    expect(clashes).toHaveLength(1)
    expect(clashes[0]!.file).toBe("src/shared.ts")
    expect(clashes[0]!.agentNames.sort()).toEqual(["Alpha", "Beta"])
  })

  test("does not report a file only one agent touches", () => {
    expect(findClashes([agent({ changedFiles: ["a.ts"] }), agent({ changedFiles: ["b.ts"] })])).toEqual([])
  })

  test("ignores merged and discarded agents so resolved work is not a permanent alarm", () => {
    const clashes = findClashes([
      agent({ changedFiles: ["src/shared.ts"], mergeState: "merged", status: "merged" }),
      agent({ changedFiles: ["src/shared.ts"] }),
    ])
    expect(clashes).toEqual([])
  })

  test("ignores finished agents even when merge state is still none", () => {
    expect(
      findClashes([
        agent({ changedFiles: ["src/shared.ts"], status: "complete" }),
        agent({ changedFiles: ["src/shared.ts"], status: "stopped" }),
      ]),
    ).toEqual([])
  })

  test("counts a duplicated path within one agent only once", () => {
    expect(findClashes([agent({ changedFiles: ["dup.ts", "dup.ts"] })])).toEqual([])
  })

  test("reports every clashing file, sorted", () => {
    const clashes = findClashes([agent({ changedFiles: ["z.ts", "a.ts"] }), agent({ changedFiles: ["a.ts", "z.ts"] })])
    expect(clashes.map((clash) => clash.file)).toEqual(["a.ts", "z.ts"])
  })
})

describe("summarize", () => {
  test("counts live, blocked, finished, unique files, and clashes", () => {
    const summary = summarize([
      agent({ status: "editing", changedFiles: ["a.ts"] }),
      agent({ status: "failed", changedFiles: ["a.ts"] }),
      agent({ status: "merged", mergeState: "merged", changedFiles: ["b.ts"] }),
    ])
    expect(summary.total).toBe(3)
    expect(summary.running).toBe(1)
    expect(summary.attention).toBe(1)
    expect(summary.finished).toBe(1)
    expect(summary.changedFiles).toBe(2)
    expect(summary.clashes).toBe(1)
  })

  test("is all zeroes for no agents", () => {
    expect(summarize([])).toEqual({
      total: 0,
      running: 0,
      attention: 0,
      finished: 0,
      changedFiles: 0,
      clashes: 0,
      teams: 0,
    })
  })
})

describe("groupAgents", () => {
  test("groups collaborative team members under one heading", () => {
    const groups = groupAgents([
      agent({ id: "a", name: "Backend", teamId: "team-1" }),
      agent({ id: "b", name: "Frontend", teamId: "team-1" }),
      agent({ id: "c", name: "Solo" }),
    ])
    const team = groups.find((group) => group.id === "team-1")
    expect(team?.swarm).toBe(true)
    expect(team?.label).toBe("Backend & Frontend")
    expect(team?.agents.map((member) => member.id)).toEqual(["a", "b"])
    expect(groups.find((group) => group.id === "c")?.swarm).toBe(false)
  })

  test("a swarm id outranks a team id for grouping", () => {
    const groups = groupAgents([
      agent({ id: "a", name: "Worker", swarmRunId: "run-1", teamId: "team-1" }),
      agent({ id: "b", name: "Mate", teamId: "team-1" }),
    ])
    expect(groups.find((group) => group.id === "run-1")?.agents.map((member) => member.id)).toEqual(["a"])
    expect(groups.find((group) => group.id === "team-1")?.agents.map((member) => member.id)).toEqual(["b"])
  })

  test("a large team labels the first two members and counts the rest", () => {
    const groups = groupAgents([
      agent({ id: "a", name: "Alpha", teamId: "t" }),
      agent({ id: "b", name: "Beta", teamId: "t" }),
      agent({ id: "c", name: "Gamma", teamId: "t" }),
    ])
    expect(groups.find((group) => group.id === "t")?.label).toBe("Alpha & Beta +1")
  })

  test("groups a swarm together and puts the coordinator first", () => {
    const groups = groupAgents([
      agent({ name: "Worker", swarmRunId: "run-1", swarmRole: "worker" }),
      agent({ name: "Lead", swarmRunId: "run-1", swarmRole: "coordinator" }),
      agent({ name: "Solo" }),
    ])
    const swarm = groups.find((group) => group.swarm)
    expect(swarm?.agents.map((item) => item.name)).toEqual(["Lead", "Worker"])
    expect(swarm?.label).toBe("Lead")
    expect(groups.filter((group) => !group.swarm).map((group) => group.label)).toEqual(["Solo"])
  })

  test("each standalone agent is its own group", () => {
    expect(groupAgents([agent(), agent()]).every((group) => group.agents.length === 1)).toBe(true)
  })
})

describe("sortForDisplay", () => {
  test("running first, then attention, then the rest", () => {
    const sorted = sortForDisplay([
      agent({ name: "done", status: "complete" }),
      agent({ name: "broken", status: "failed" }),
      agent({ name: "live", status: "editing" }),
    ])
    expect(sorted.map((item) => item.name)).toEqual(["live", "broken", "done"])
  })
})

describe("elapsedLabel", () => {
  const now = Date.parse("2026-08-15T20:10:00.000Z")

  test("counts to now while running", () => {
    expect(elapsedLabel(agent({ status: "editing" }), now)).toBe("10m 0s")
  })

  test("freezes at last activity once finished", () => {
    expect(elapsedLabel(agent({ status: "complete" }), now)).toBe("5m 0s")
  })

  test("formats seconds and hours", () => {
    expect(elapsedLabel(agent({ createdAt: "2026-08-15T20:09:30.000Z", status: "editing" }), now)).toBe("30s")
    expect(elapsedLabel(agent({ createdAt: "2026-08-15T18:00:00.000Z", status: "editing" }), now)).toBe("2h 10m")
  })

  test("is empty for an unparseable timestamp", () => {
    expect(elapsedLabel(agent({ createdAt: "not a date" }), now)).toBe("")
  })
})

describe("agentCardDetails", () => {
  test("keeps board and list metadata consistent", () => {
    expect(
      agentCardDetails(
        agent({
          runtime: "Claude Code",
          model: "claude-sonnet-5",
          lastAction: "Editing src/auth.ts",
          changedFilesCount: 2,
          changedFiles: ["src/auth.ts", "src/auth.test.ts"],
          actualCost: "$0.08",
          estimatedCost: "$0.10",
        }),
      ),
    ).toEqual({
      activity: "Editing src/auth.ts",
      changes: "2 files changed",
      cost: "$0.08",
      runtime: "Claude Code · claude-sonnet-5",
    })
  })

  test("a Vector-runtime agent never shows the estimate band", () => {
    expect(agentCardDetails(agent({ runtime: "vector", status: "editing", estimatedCost: "< $0.01" })).cost).toBe(
      "measuring…",
    )
    expect(agentCardDetails(agent({ runtime: "vector", status: "complete", estimatedCost: "< $0.01" })).cost).toBe(
      "unmeasured",
    )
    expect(agentCardDetails(agent({ runtime: "vector", status: "failed", actualCost: "$0.42" })).cost).toBe("$0.42")
  })

  test("uses a reported error as the most important activity", () => {
    expect(agentCardDetails(agent({ error: "Typecheck failed", lastAction: "Running tests" })).activity).toBe(
      "Typecheck failed",
    )
  })

  test("counts distinct changed paths when the persisted count is stale", () => {
    expect(
      agentCardDetails(agent({ changedFilesCount: 0, changedFiles: ["src/a.ts", "src/a.ts", "src/b.ts"] })).changes,
    ).toBe("2 files changed")
  })
})

describe("team conversation", () => {
  const message = (id: string, createdAt: string, toWorkspaceId?: string) => ({
    id,
    fromWorkspaceId: "a",
    fromName: "Alpha",
    toWorkspaceId,
    text: "t",
    createdAt,
  })

  test("orders a transcript oldest first", () => {
    const ordered = orderConversation([
      message("second", "2026-08-15T20:05:00.000Z"),
      message("first", "2026-08-15T20:00:00.000Z"),
    ])
    expect(ordered.map((m) => m.id)).toEqual(["first", "second"])
  })

  test("does not mutate the input", () => {
    const input = [message("b", "2026-08-15T20:05:00.000Z"), message("a", "2026-08-15T20:00:00.000Z")]
    orderConversation(input)
    expect(input.map((m) => m.id)).toEqual(["b", "a"])
  })

  test("distinguishes a directed reply from a broadcast handoff", () => {
    expect(isDirected(message("x", "2026-08-15T20:00:00.000Z", "b"))).toBe(true)
    expect(isDirected(message("y", "2026-08-15T20:00:00.000Z"))).toBe(false)
  })
})

describe("summarize teams", () => {
  test("counts distinct teams and ignores agents without one", () => {
    expect(summarize([agent({ teamId: "t1" }), agent({ teamId: "t1" }), agent({ teamId: "t2" }), agent()]).teams).toBe(
      2,
    )
  })
})

describe("board columns", () => {
  test("every agent lands in exactly one of running, needs you, or done", () => {
    const agents = [
      agent({ status: "editing" }),
      agent({ status: "queued" }),
      agent({ status: "needs review" }),
      agent({ status: "failed" }),
      agent({ status: "complete" }),
      agent({ status: "merged" }),
    ]
    const columns = boardColumns(agents)
    expect(columns.map((column) => column.id)).toEqual(["running", "attention", "done"])
    expect(columns.flatMap((column) => column.agents).length).toBe(agents.length)
    expect(columns[0]?.agents.length).toBe(2)
    expect(columns[1]?.agents.length).toBe(2)
    expect(columns[2]?.agents.length).toBe(2)
  })

  test("a completed agent carrying an error still needs a person", () => {
    // needsAttention keys on the error too, and a run that reported one is not
    // finished business just because its status says complete.
    const columns = boardColumns([agent({ status: "complete", error: "guardrails failed" })])
    expect(columns[1]?.agents.length).toBe(1)
    expect(columns[2]?.agents.length).toBe(0)
  })

  test("the columns keep the display sort, so live work leads", () => {
    const columns = boardColumns([
      agent({ status: "editing", lastActivityAt: "2026-08-15T20:01:00.000Z" }),
      agent({ status: "editing", lastActivityAt: "2026-08-15T20:09:00.000Z" }),
    ])
    expect(columns[0]?.agents[0]?.lastActivityAt).toBe("2026-08-15T20:09:00.000Z")
  })
})

describe("filtering agents", () => {
  test("a query matches name, task, last action, runtime or model", () => {
    const target = agent({ name: "Warmup", taskPrompt: "add a learning rate warmup phase" })
    const other = agent({ name: "Baseline", taskPrompt: "establish the training baseline" })
    expect(filterAgents([target, other], { query: "warmup" })).toEqual([target])
    expect(filterAgents([target, other], { query: "TRAINING" })).toEqual([other])
    expect(filterAgents([target, other], { query: "   " }).length).toBe(2)
  })

  test("filters are OR within a facet and AND across facets", () => {
    const a = agent({ status: "editing", runtime: "vector" })
    const b = agent({ status: "failed", runtime: "codex" })
    const c = agent({ status: "editing", runtime: "codex" })
    expect(filterAgents([a, b, c], { statuses: ["editing", "failed"] }).length).toBe(3)
    expect(filterAgents([a, b, c], { statuses: ["editing"], runtimes: ["codex"] })).toEqual([c])
  })

  test("pull request filters separate open, merged and never-opened", () => {
    const open = agent({ pullRequestUrl: "https://github.com/o/r/pull/1" })
    const merged = agent({ pullRequestUrl: "https://github.com/o/r/pull/2", mergeState: "merged" })
    const none = agent({})
    const all = [open, merged, none]
    expect(filterAgents(all, { pullRequest: "open" })).toEqual([open])
    // A merged run still has a pullRequestUrl, so merge state has to win or it
    // would show up under "open" forever.
    expect(filterAgents(all, { pullRequest: "merged" })).toEqual([merged])
    expect(filterAgents(all, { pullRequest: "none" })).toEqual([none])
  })

  test("grouping filters treat unteamed agents as solo", () => {
    const teamed = agent({ teamId: "team-1" })
    const swarmed = agent({ swarmRunId: "swarm-1" })
    const alone = agent({})
    expect(filterAgents([teamed, swarmed, alone], { groups: ["solo"] })).toEqual([alone])
    expect(filterAgents([teamed, swarmed, alone], { groups: ["team-1", "swarm-1"] }).length).toBe(2)
  })

  test("hasActiveFilters ignores an all-whitespace query", () => {
    expect(hasActiveFilters({})).toBe(false)
    expect(hasActiveFilters({ query: "   " })).toBe(false)
    expect(hasActiveFilters({ query: "warmup" })).toBe(true)
    expect(hasActiveFilters({ statuses: [] })).toBe(false)
    expect(hasActiveFilters({ pullRequest: "open" })).toBe(true)
  })
})

describe("agentCostLabel", () => {
  test("external runtimes keep their estimate until their own cost arrives", () => {
    expect(agentCostLabel({ runtime: "claude-code", estimatedCost: "$0.10", running: true })).toBe("$0.10")
    expect(agentCostLabel({ runtime: "claude-code", estimatedCost: "", running: false })).toBeUndefined()
    expect(
      agentCostLabel({ runtime: "claude-code", estimatedCost: "$0.10", actualCost: "$0.20", running: false }),
    ).toBe("$0.20")
  })

  test("measured cost prints like the rest of the app", () => {
    expect(agentCostLabel({ runtime: "vector", estimatedCost: "", actualCost: "$0.4213", running: false })).toBe(
      "$0.42",
    )
    expect(agentCostLabel({ runtime: "vector", estimatedCost: "", actualCost: "$0.0031", running: false })).toBe(
      "<$0.01",
    )
    expect(agentCostLabel({ runtime: "claude-code", estimatedCost: "", actualCost: "$1,204.5", running: false })).toBe(
      "$1,204.50",
    )
    expect(agentCostLabel({ runtime: "claude-code", estimatedCost: "", actualCost: "n/a", running: false })).toBe("n/a")
  })

  test("the Vector runtime is measured, measuring or unmeasured", () => {
    expect(agentCostLabel({ runtime: "vector", estimatedCost: "", running: true })).toBe("measuring…")
    expect(agentCostLabel({ runtime: "vector", estimatedCost: "< $0.01", running: false })).toBe("unmeasured")
    expect(agentCostLabel({ runtime: "vector", estimatedCost: "", actualCost: "$0.42", running: false })).toBe("$0.42")
  })
})

test("Codium agent cards replace zero-dollar estimates and retain mixed own-key spend", () => {
  const input = { runtime: "vector", estimatedCost: "$9.00", running: false, billing: "codium" as const }
  expect(agentCostLabel(input)).toBe("Codium")
  expect(agentCostLabel({ ...input, actualCost: "$0.00" })).toBe("Codium")
  expect(agentCostLabel({ ...input, actualCost: "$0.12" })).toBe("$0.12 + Codium")
  expect(agentCostLabel({ ...input, costKind: "unknown" })).toBe("Cost unknown + Codium")
  expect(agentCostLabel({ ...input, actualCost: "$0.12", costKind: "unknown" })).toBe("$0.12 + unpriced + Codium")
  expect(agentCostLabel({ ...input, actualCost: "$0.00", costKind: "free" })).toBe("free model + Codium")
})
