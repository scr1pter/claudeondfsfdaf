import { expect, test } from "bun:test"
import {
  canAlwaysAllowPermission,
  canAutoApprovePermission,
  cloudPermissionDetails,
  workflowAsk,
  workflowPlanLines,
} from "../../src/util/permission"

test("automatic permission mode never approves doom-loop continuation", () => {
  expect(canAutoApprovePermission("edit")).toBe(true)
  expect(canAutoApprovePermission("doom_loop")).toBe(false)
  expect(canAutoApprovePermission("browser_sensitive")).toBe(false)
  expect(canAutoApprovePermission("computer_interact")).toBe(false)
})

test("a change to a memory file after outside content always asks", () => {
  expect(canAutoApprovePermission("memory_source", ["*"])).toBe(false)
  expect(canAlwaysAllowPermission("memory_source", ["*"])).toBe(false)
})

test("a change to a file Vector's prompts are read from always asks", () => {
  expect(canAutoApprovePermission("prompt_source", ["*"])).toBe(false)
  expect(canAlwaysAllowPermission("prompt_source", ["*"])).toBe(false)
})

test("sensitive permissions can only be allowed once", () => {
  expect(canAlwaysAllowPermission("webfetch", ["https://example.com"])).toBe(true)
  expect(canAlwaysAllowPermission("browser_sensitive", ["*"])).toBe(false)
  expect(canAlwaysAllowPermission("computer_sensitive", ["window:42:0"])).toBe(false)
})

test.each(["vector_cloud_publish", "vector_cloud_database", "vector_cloud_environment", "vector_cloud_hosting"])(
  "Cloud write %s never auto-accepts or retains approval",
  (permission) => {
    expect(canAutoApprovePermission(permission, ["*"])).toBe(false)
    expect(canAlwaysAllowPermission(permission, ["*"])).toBe(false)
  },
)

test("Cloud each-time requests stay manual and repeatable inspection can auto-accept", () => {
  expect(canAutoApprovePermission("vector_cloud_future", [])).toBe(false)
  expect(canAutoApprovePermission("vector_cloud_future")).toBe(false)
  expect(canAlwaysAllowPermission("vector_cloud_future", [])).toBe(false)
  expect(canAutoApprovePermission("vector_cloud_inspect", ["supabase/project/preview"])).toBe(true)
})

test("Cloud permission details retain the full SQL and exact account scope", () => {
  const sql = "select '" + "x".repeat(20_000) + "';\nselect 2;"
  const details = cloudPermissionDetails({
    permission: "vector_cloud_database",
    metadata: {
      provider: "Supabase",
      project: "shop",
      environment: "production",
      summary: "Apply migration",
      statements: [{ label: "Migration 001", sql, length: sql.length }, null, { sql: 2 }],
    },
  })
  expect(details?.rows).toEqual([
    { label: "Provider", value: "Supabase" },
    { label: "Supabase project", value: "shop" },
    { label: "Environment", value: "production" },
  ])
  expect(details?.summary).toBe("Apply migration")
  expect(details?.statements).toEqual([{ label: "Migration 001", sql, incomplete: false }])
  expect(cloudPermissionDetails({ permission: "edit", metadata: {} })).toBeUndefined()
  expect(
    cloudPermissionDetails({
      permission: "vector_cloud_database",
      metadata: { statements: [{ label: "old", sql: "select", length: 99 }] },
    })?.statements[0].incomplete,
  ).toBe(true)
})

// 5.I.5 and I15: a workflow ask after outside content, under the agent marker or past the defaults always asks.
const plan = {
  title: "Audit",
  stages: [
    {
      id: "review",
      title: "Review each file",
      phase: "main",
      agent: "explore",
      items: 12,
      serial: false,
      writes: "read only",
      asks: ["bash"],
      verify: { agent: "judge", maxRounds: 2 },
    },
  ],
  maxAgents: 12,
  concurrency: 4,
  steps: 480,
  perAgentSteps: 60,
  minutes: 120,
}

test.each(["web", "mcp", "agent", "large"] as const)("a workflow after-web %s ask is never auto-approved", (reason) => {
  const patterns = [`after-web workflow:${reason}`]
  expect(canAutoApprovePermission("workflow", [], patterns)).toBe(false)
  expect(canAlwaysAllowPermission("workflow", [], patterns)).toBe(false)
  // Even an always list the engine never sends cannot make it savable.
  expect(canAutoApprovePermission("workflow", ["run"], patterns)).toBe(false)
  expect(canAlwaysAllowPermission("workflow", ["run"], patterns)).toBe(false)
  const ask = workflowAsk({
    permission: "workflow",
    patterns,
    always: [],
    metadata: { ...plan, delegated: { usd: 25 } },
  })
  expect(ask?.elevated).toBe(true)
  expect(ask?.canAlways).toBe(false)
  expect(ask?.reason).toContain("cannot be allowed always")
})

test("a workflow within the defaults can be approved once or always, and shows its plan and ceilings", () => {
  expect(canAutoApprovePermission("workflow", ["run"], ["run"])).toBe(true)
  const ask = workflowAsk({
    permission: "workflow",
    patterns: ["run"],
    always: ["run"],
    metadata: { ...plan, delegated: { usd: 25 } },
  })
  expect(ask).toMatchObject({ elevated: false, canAlways: true, delegated: { usd: 25 } })
  expect(ask?.reason).toBeUndefined()
  expect(workflowPlanLines(ask!.plan!, ask!.delegated)).toEqual([
    "Audit",
    "- Review each file · explore · 12 items · read only · checked by judge, up to 2 rounds · asks: bash",
    "Up to 12 agents · 4 at once · 480 steps · 60 steps per agent · 120 minutes · shares the $25.00 subagent ceiling",
  ])
  // A workflow ask with no pattern at all is elevated too.
  expect(canAutoApprovePermission("workflow", ["run"], [])).toBe(false)
  expect(workflowAsk({ permission: "workflow", patterns: [], always: ["run"] })?.canAlways).toBe(false)
  expect(workflowAsk({ permission: "edit", patterns: ["*"], always: ["*"] })).toBeUndefined()
})

test("a workflow plan's model-written strings are sanitized and a malformed plan reads as none", () => {
  const lines = workflowPlanLines(
    workflowAsk({
      permission: "workflow",
      patterns: ["run"],
      always: ["run"],
      metadata: { ...plan, title: "Audit\u001b]52;c;eA==\u0007", stages: [{ ...plan.stages[0], title: "x\u202ey" }] },
    })!.plan!,
  )
  expect(lines.join("\n")).not.toMatch(/[\u001b\u0007\u202e]/)
  expect(workflowAsk({ permission: "workflow", patterns: ["run"], metadata: { title: "x" } })?.plan).toBeUndefined()
})
