import { describe, expect, test } from "bun:test"
import { WORKFLOW_CHIP, changed, chipLabel, insightsPlace } from "./workflow"

describe("the learned workflow default under a reply", () => {
  test("says a learned default and a try apart", () => {
    expect(chipLabel({ source: "learned" })).toBe("Learned default")
    expect(chipLabel({ source: "explore" })).toBe("Trying a cheaper default")
  })

  test("says what the default changed, and only what it changed", () => {
    expect(changed({ effort: "default" })).toBe("Default effort instead of Thorough's high effort")
    expect(changed({ split: "solo", subagentModel: "small" })).toBe(
      "Worked without subagents · The small model for subagents",
    )
    expect(changed({})).toBe("")
  })

  test("opens Workflow insights on the repository and folder the reply ran in", () => {
    expect(insightsPlace({ path: { root: "/repo", cwd: "/repo/packages/app" } })).toEqual({
      repositoryPath: "/repo",
      sessionDirectory: "/repo/packages/app",
    })
  })

  test("says the user's picks win and spend caps are unchanged, and how to stop", () => {
    expect(WORKFLOW_CHIP.own).toContain("Your own picks always win")
    expect(WORKFLOW_CHIP.own).toContain("spend caps are unchanged")
    expect(WORKFLOW_CHIP.stop).toBe("Stop using learned defaults")
    expect(WORKFLOW_CHIP.stopped).toContain("Settings > Memory > Workflow insights")
  })
})
