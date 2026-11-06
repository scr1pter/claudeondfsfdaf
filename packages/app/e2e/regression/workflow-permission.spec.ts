import { expect, test, type Page } from "@playwright/test"
import { composer, posts, rootID, setup, toast, userMessage } from "../utils/multiagent"

// Workflow approval (5.G.3, 5.I.4, I15): the permission dock shows the plan and every ceiling; an ask after outside
// content hides Always allow and says why; `/workflow <name>` opens the saved workflow's form, which shows the plan
// from route 8 before Run starts it with route 9.

const plan = {
  title: "Review the parser",
  stages: [
    {
      id: "find",
      title: "Find parser files",
      phase: "map",
      agent: "explore",
      items: "dynamic",
      serial: false,
      writes: "read only",
      asks: [],
    },
    {
      id: "review",
      title: "Review each file",
      phase: "review",
      agent: "general",
      items: 4,
      serial: false,
      writes: "",
      asks: ["bash"],
      verify: { agent: "review", maxRounds: 2 },
    },
  ],
  maxAgents: 12,
  concurrency: 4,
  steps: 480,
  perAgentSteps: 40,
  minutes: 30,
}

function ask(patterns: string[], always: string[]) {
  return {
    id: "per_workflow",
    sessionID: rootID,
    permission: "workflow",
    patterns,
    always,
    metadata: { ...plan, delegated: { usd: 25 } },
  }
}

const dock = (page: Page) => page.locator('[data-component="dock-prompt"][data-kind="permission"]')

test("the workflow permission dock shows the plan and every ceiling", async ({ page }) => {
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, workflows: true },
    status: { [rootID]: { type: "busy" } },
    permissions: [ask(["run"], ["run"])],
  })
  await app.open()
  const prompt = dock(page)
  const view = prompt.locator('[data-component="workflow-plan"]')
  await expect(view).toContainText("Review the parser")
  await expect(view.locator('[data-slot="workflow-plan-ceilings"]')).toHaveText(
    "Up to 12 agents · 4 at once · 480 steps · 40 steps per agent · 30 minutes · shares the $25.00 subagent ceiling",
  )
  const stages = view.locator("li")
  await expect(stages).toHaveCount(2)
  await expect(stages.nth(0)).toHaveText("Find parser files · explore · items found while it runs · read only")
  await expect(stages.nth(1)).toHaveText(
    "Review each file · general · 4 items · checked by review, up to 2 rounds · asks: bash",
  )
  // A plan within the defaults may be allowed always.
  await expect(prompt.getByRole("button", { name: "Allow always", exact: true })).toBeVisible()
  await expect(prompt.locator('[data-component="workflow-permission-reason"]')).toHaveCount(0)

  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/session/${rootID}/permissions/per_workflow`,
  )
  await prompt.getByRole("button", { name: "Allow once", exact: true }).click()
  expect((await reply).postDataJSON()).toEqual({ response: "once" })
})

test("a workflow asked for after web content hides Always allow and says why", async ({ page }) => {
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, workflows: true },
    status: { [rootID]: { type: "busy" } },
    permissions: [ask(["after-web workflow:web"], [])],
  })
  await app.open()
  const prompt = dock(page)
  await expect(prompt.locator('[data-component="workflow-plan"]')).toContainText("Review the parser")
  await expect(prompt.locator('[data-component="workflow-permission-reason"]')).toHaveText(
    "This conversation read the web, which may have shaped this plan, so it asks every time and cannot be allowed always.",
  )
  await expect(prompt.getByRole("button", { name: "Allow always" })).toHaveCount(0)
  await expect(prompt.getByRole("button", { name: "Allow once", exact: true })).toBeVisible()
  await expect(prompt.getByRole("button", { name: "Deny", exact: true })).toBeVisible()
  // The raw pattern is not shown in place of the plan.
  await expect(prompt).not.toContainText("after-web workflow:web")
})

test("/workflow opens the saved workflow's form, shows the plan from validate, then Run starts it", async ({
  page,
}) => {
  const app = await setup(page, {
    capabilities: { backgroundSubagents: true, workflows: true },
    messages: { [rootID]: [userMessage(rootID, "msg_0001_user", "Rewrite the parser")] },
    workflow: (request) => {
      if (request.action === "saved")
        return {
          workflows: [
            {
              name: "review-parser",
              title: "Review the parser",
              description: "Find every parser file and review it.",
              source: "user",
              inputs: [{ name: "path", description: "Where to look", required: false, default: "src" }],
            },
          ],
        }
      if (request.action === "validate") return { ok: true, issues: [], warnings: [], plan }
      if (request.action === "start") return { runID: "ses_wf_started", title: "Review the parser", plan }
      return undefined
    },
  })
  await app.open()
  await composer(page).click()
  await page.keyboard.type("/workflow review-parser")
  await page.keyboard.press("Enter")

  const dialog = page.getByRole("dialog", { name: "Run a saved workflow" })
  await expect(dialog).toContainText("Review the parser")
  await expect(dialog.getByLabel("path")).toBeVisible()
  // Nothing runs before the plan is checked.
  await expect(dialog.getByRole("button", { name: "Run", exact: true })).toHaveCount(0)
  expect(posts(app.capture.session, `/session/${rootID}/prompt_async`)).toHaveLength(0)
  await dialog.getByRole("button", { name: "Check plan", exact: true }).click()

  await expect.poll(() => posts(app.capture.workflow, "/experimental/workflow/validate").length).toBe(1)
  expect(posts(app.capture.workflow, "/experimental/workflow/validate")[0]!.body).toEqual({
    name: "review-parser",
    inputs: {},
  })
  const view = dialog.locator('[data-component="workflow-plan"]')
  await expect(view).toContainText("Review the parser")
  await expect(view.locator('[data-slot="workflow-plan-ceilings"]')).toContainText("Up to 12 agents · 4 at once")
  expect(posts(app.capture.workflow, `/experimental/session/${rootID}/workflow`)).toHaveLength(0)

  await dialog.getByRole("button", { name: "Run", exact: true }).click()
  await expect.poll(() => posts(app.capture.workflow, `/experimental/session/${rootID}/workflow`).length).toBe(1)
  expect(posts(app.capture.workflow, `/experimental/session/${rootID}/workflow`)[0]!.body).toEqual({
    name: "review-parser",
    inputs: {},
  })
  await expect(dialog).toBeHidden()
  await expect(toast(page, "Workflow started: Review the parser")).toBeVisible()
})
