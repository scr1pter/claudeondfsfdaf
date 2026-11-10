import { describe, expect, test } from "bun:test"
import {
  WORKFLOW_DEFAULTS,
  ceilingDefault,
  parseCeiling,
  readWorkflowSettings,
  workflowCeilingsPatch,
  workflowCeilingsResetPatch,
  workflowModePatch,
  workflowPermission,
  workflowSwitchPatch,
} from "./workflow-settings-model"

describe("workflow settings", () => {
  // The engine's WorkflowDefaults (packages/core/src/v1/config/config.ts), stated here: the app does not import the
  // config module, which pulls engine-only files into the app's program.
  test("defaults are the engine's", () => {
    expect(WORKFLOW_DEFAULTS).toEqual({
      max_agents: 100,
      concurrency: 16,
      steps_per_agent: 40,
      per_agent_steps: 60,
      minutes: 120,
      runs: 1,
    })
  })

  test("on, asking first, with no ceilings when the config says nothing", () => {
    expect(readWorkflowSettings(undefined)).toEqual({ enabled: true, mode: "ask", toolOff: false, ceilings: {} })
    expect(readWorkflowSettings({})).toEqual({ enabled: true, mode: "ask", toolOff: false, ceilings: {} })
  })

  test("permission.workflow deny or tools.workflow false is off", () => {
    expect(readWorkflowSettings({ permission: { workflow: "deny" } }).enabled).toBe(false)
    expect(readWorkflowSettings({ tools: { workflow: false } })).toMatchObject({ enabled: false, toolOff: true })
    expect(readWorkflowSettings({ permission: { workflow: "allow" } })).toMatchObject({ enabled: true, mode: "allow" })
  })

  test("reads the permission as the engine does: the last matching rule wins, a bare action covers every tool", () => {
    expect(workflowPermission(undefined)).toBe("ask")
    expect(workflowPermission("allow")).toBe("allow")
    expect(workflowPermission("deny")).toBe("deny")
    expect(workflowPermission({ "*": "deny" })).toBe("deny")
    expect(workflowPermission({ "*": "deny", workflow: "ask" })).toBe("ask")
    expect(workflowPermission({ workflow: "allow", "*": "deny" })).toBe("deny")
    expect(workflowPermission({ workflow: { "*": "allow" } })).toBe("allow")
    expect(workflowPermission({ bash: "deny", edit: "allow" })).toBe("ask")
  })

  test("turning off writes permission.workflow deny; on writes the mode and clears tools.workflow false", () => {
    expect(workflowSwitchPatch({}, false, "ask")).toEqual({ permission: { workflow: "deny" } })
    expect(workflowSwitchPatch({ permission: { workflow: "deny" } }, true, "ask")).toEqual({
      permission: { workflow: "ask" },
    })
    expect(workflowSwitchPatch({ tools: { workflow: false } }, true, "allow")).toEqual({
      permission: { workflow: "allow" },
      tools: { workflow: true },
    })
    expect(workflowModePatch({}, "allow")).toEqual({ permission: { workflow: "allow" } })
  })

  test("a bare permission action is kept for every tool, before the workflow rule", () => {
    const patch = workflowSwitchPatch({ permission: "allow" }, false, "ask")
    expect(patch).toEqual({ permission: { "*": "allow", workflow: "deny" } })
    expect(Object.keys(patch.permission as object)).toEqual(["*", "workflow"])
    expect(workflowPermission(patch.permission)).toBe("deny")
  })

  test("reads the ceilings budget.workflow sets", () => {
    expect(
      readWorkflowSettings({ budget: { workflow: { max_agents: 300, usd: 4.5, minutes: 30, runs: 2 } } }).ceilings,
    ).toEqual({ max_agents: 300, usd: 4.5, minutes: 30, runs: 2 })
  })

  test("ranges follow the config schema", () => {
    expect(parseCeiling("max_agents", "1000")).toEqual({ ok: true, value: 1000 })
    expect(parseCeiling("max_agents", "1001").ok).toBe(false)
    expect(parseCeiling("concurrency", "17").ok).toBe(false)
    expect(parseCeiling("minutes", "1440")).toEqual({ ok: true, value: 1440 })
    expect(parseCeiling("minutes", "1441").ok).toBe(false)
    expect(parseCeiling("runs", "4")).toEqual({ ok: true, value: 4 })
    expect(parseCeiling("runs", "5").ok).toBe(false)
    expect(parseCeiling("steps", "0").ok).toBe(false)
    expect(parseCeiling("steps", "250000")).toEqual({ ok: true, value: 250000 })
    expect(parseCeiling("tokens", "1.5").ok).toBe(false)
    expect(parseCeiling("usd", "$2.50")).toEqual({ ok: true, value: 2.5 })
    expect(parseCeiling("usd", "0").ok).toBe(false)
    expect(parseCeiling("usd", "")).toEqual({ ok: true, value: undefined })
  })

  test("the patch writes only changed ceilings under budget.workflow", () => {
    expect(workflowCeilingsPatch({}, {})).toEqual({ ok: true, patch: undefined })
    expect(workflowCeilingsPatch({}, { max_agents: "300", usd: "10" })).toEqual({
      ok: true,
      patch: { budget: { workflow: { max_agents: 300, usd: 10 } } },
    })
    expect(workflowCeilingsPatch({ max_agents: 300 }, { max_agents: "300", minutes: "30" })).toEqual({
      ok: true,
      patch: { budget: { workflow: { minutes: 30 } } },
    })
  })

  test("blanking a saved ceiling writes its default; steps follows the agents in the same save", () => {
    expect(workflowCeilingsPatch({ minutes: 30 }, { minutes: "" })).toEqual({
      ok: true,
      patch: { budget: { workflow: { minutes: 120 } } },
    })
    expect(workflowCeilingsPatch({ steps: 100 }, { max_agents: "50", steps: "" })).toEqual({
      ok: true,
      patch: { budget: { workflow: { max_agents: 50, steps: 2000 } } },
    })
    expect(ceilingDefault("steps", {})).toBe(4000)
  })

  test("a saved spend or token ceiling cannot be cleared through an update, and says so", () => {
    const refused = workflowCeilingsPatch({ usd: 5 }, { usd: "" })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.message).toContain("budget.workflow.usd")
    expect(workflowCeilingsPatch({ tokens: 9 }, { tokens: "" }).ok).toBe(false)
  })

  test("an invalid field refuses the whole save", () => {
    expect(workflowCeilingsPatch({}, { concurrency: "40", minutes: "30" }).ok).toBe(false)
  })

  test("Reset writes the explicit default of every ceiling that has one", () => {
    expect(workflowCeilingsResetPatch()).toEqual({
      budget: {
        workflow: { max_agents: 100, concurrency: 16, steps: 4000, per_agent_steps: 60, minutes: 120, runs: 1 },
      },
    })
  })
})
