import { beforeAll, describe, expect, mock, test } from "bun:test"

let mod: typeof import("./workflow-part")

beforeAll(async () => {
  // Bun loads Solid's server build, where the router and the tooltips' popper cannot load. The pure helpers use neither.
  mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "" }) }))
  mock.module("@vectordevai/ui/tooltip", () => ({ Tooltip: () => undefined, TooltipKeybind: () => undefined }))
  mock.module("@vectordevai/ui/v2/tooltip-v2", () => ({ TooltipV2: () => undefined }))
  mod = await import("./workflow-part")
})

const plan = {
  title: "Review changes",
  stages: [
    { id: "files", title: "Review each file", agent: "review", items: "dynamic", writes: "read only", asks: [] },
    { id: "fix", agent: "general", items: 1, writes: "in this checkout, one at a time", asks: [] },
  ],
  maxAgents: 100,
  concurrency: 8,
  steps: 4000,
  perAgentSteps: 60,
  minutes: 120,
  usd: 5,
}

describe("workflow part", () => {
  test("a started run shows its title, plan and run link", () => {
    const view = mod.workflowPartView({
      input: { name: "review-changes" },
      metadata: { action: "run", runID: "ses_run" },
      output: JSON.stringify({ runID: "ses_run", title: "Review changes", plan }),
      status: "completed",
    })
    expect(view).toMatchObject({ action: "run", title: "Workflow", subtitle: "Review changes", state: "started" })
    expect(view.runID).toBe("ses_run")
    expect(view.plan?.limits).toBe("up to 100 agents · 8 at once · 120 minutes · $5.00 for this run")
    expect(view.plan?.stages.map(mod.workflowStageLine)).toEqual([
      "Review each file · review · items found while it runs · read only",
      "fix · general · 1 item · in this checkout, one at a time",
    ])
  })

  test("while it waits for approval there is no run yet; a refused run has no link", () => {
    expect(mod.workflowPartView({ input: { name: "review-changes" }, metadata: {}, status: "running" })).toMatchObject({
      state: "waiting for approval",
      subtitle: "review-changes",
    })
    expect(mod.workflowPartView({ input: {}, metadata: { sessionId: "ses_run" }, status: "running" })).toMatchObject({
      state: "starting",
      runID: "ses_run",
    })
    expect(
      mod.workflowPartView({ input: {}, metadata: { sessionId: "ses_run" }, status: "error" }).runID,
    ).toBeUndefined()
  })

  test("a check lists its issues; the guide is just a title", () => {
    const view = mod.workflowPartView({
      input: { action: "validate" },
      metadata: { action: "validate", valid: false },
      output: JSON.stringify({ ok: false, issues: [{ path: "/stages/0", message: "Unknown key" }], warnings: [] }),
      status: "completed",
    })
    expect(view).toMatchObject({ action: "validate", state: "has issues", issues: ["/stages/0: Unknown key"] })
    expect(mod.workflowPartView({ input: { action: "guide" }, metadata: { action: "guide" } })).toEqual({
      action: "guide",
      title: "Workflow guide",
      issues: [],
    })
  })

  test("output that is not a plan reads as no plan", () => {
    expect(mod.workflowPartPlan({ title: "x", stages: "no" })).toBeUndefined()
    expect(
      mod.workflowPartView({ input: {}, metadata: { action: "run" }, output: "not json", status: "completed" }).plan,
    ).toBeUndefined()
  })
})

describe("worktree chip", () => {
  test("changes waiting for review name the file count and branch", () => {
    expect(mod.worktreeChip({ mode: "worktree", state: "changed", files: 3, branch: "vector/task-a" })).toBe(
      "3 files changed · vector/task-a",
    )
    expect(mod.worktreeChip({ mode: "worktree", state: "changed", files: 1 })).toBe("1 file changed")
  })

  test("other states say what happened", () => {
    expect(mod.worktreeChip({ mode: "worktree", state: "active", branch: "vector/task-a" })).toBe(
      "Worktree · vector/task-a",
    )
    expect(mod.worktreeChip({ mode: "worktree", state: "unchanged" })).toBe("No changes")
    expect(mod.worktreeChip({ mode: "worktree", state: "merged" })).toBe("Merged")
    expect(mod.worktreeChip({ mode: "worktree", state: "discarded" })).toBe("Discarded")
    expect(mod.worktreeChip(undefined)).toBeUndefined()
    expect(mod.worktreeChip({ mode: "worktree" })).toBeUndefined()
  })
})
