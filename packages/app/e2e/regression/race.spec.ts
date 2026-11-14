import { expect, test } from "@playwright/test"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { posts, rootID, setup } from "../utils/multiagent"

test("Race previews independent worktrees before starting and invalidates preview after an edit", async ({ page }) => {
  const app = await setup(page, { capabilities: { backgroundSubagents: true, workflows: true }, workflow: (request) => {
    if (request.action !== "validate" && request.action !== "start") return undefined
    const body = request.body as { spec: string }
    const built = WorkflowPlan.build(body.spec, { agents: [{ name: "general", allowed: true, writes: true }, { name: "review", allowed: true, writes: false }], source: "owner", cpus: 8, modelAllowed: () => true })
    if (request.action === "validate") return { ok: built.ok, issues: built.issues, warnings: built.warnings, plan: built.plan }
    return { runID: "ses_race", title: "Model race", plan: built.plan }
  } })
  await app.open()
  await page.getByRole("button", { name: "Background tasks", exact: true }).click()
  await page.getByRole("button", { name: "Race models", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Race models", exact: true })
  await dialog.getByLabel("Request", { exact: true }).fill("Fix the parser and test it.")
  await dialog.getByLabel("First lane", { exact: true }).fill("openrouter/anthropic/claude-sonnet")
  await dialog.getByLabel("Second lane", { exact: true }).fill("openrouter/openai/gpt-6")
  await dialog.getByLabel("Judge from a third lab", { exact: true }).fill("openrouter/google/gemini-4")
  await expect(dialog.getByRole("button", { name: "Run race", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Preview race", exact: true }).click()
  await expect(dialog.locator('[data-component="workflow-plan"]')).toContainText("Model race")
  const validated = posts(app.capture.workflow, "/experimental/workflow/validate")
  expect(validated).toHaveLength(1)
  const spec = JSON.parse((validated[0]!.body as { spec: string }).spec)
  expect(spec.stages.slice(0, 2).map((stage: { isolation: string }) => stage.isolation)).toEqual(["worktree", "worktree"])
  expect(spec.stages[2]).toMatchObject({ agent: "review", after: ["lane_1", "lane_2"] })
  expect(posts(app.capture.workflow, `/experimental/session/${rootID}/workflow`)).toHaveLength(0)
  await dialog.getByLabel("Request", { exact: true }).fill("Fix the parser and add a regression.")
  await expect(dialog.getByRole("button", { name: "Run race", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Preview race", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Run race", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Run race", exact: true }).click()
  await expect.poll(() => posts(app.capture.workflow, `/experimental/session/${rootID}/workflow`).length).toBe(1)
  await expect(dialog).toBeHidden()
})
