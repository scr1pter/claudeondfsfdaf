import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/CodiumUsageLabels"
const project = { id: "project-codium-usage-labels", worktree: directory, vcs: "git", name: "Codium usage labels" }
const rawCodiumTokens = { input: 99_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } }

for (const mixed of [false, true]) {
  test(`${mixed ? "mixed" : "Codium-only"} session keeps Codium quantities out of the pill, tooltip and Context ledger`, async ({
    page,
  }) => {
    const sessionID = mixed ? "ses_codium_labels_mixed" : "ses_codium_labels_only"
    const title = mixed ? "Mixed model work" : "Codium model work"
    const model = { providerID: "vector-plan", modelID: "coding" }
    const own = { providerID: "openai", modelID: "own-coding" }
    const tokens = { input: mixed ? 48_000 : 0, output: mixed ? 213 : 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const cost = mixed ? 0.12 : 0
    const assistant = (
      id: string,
      provider: typeof model,
      time: number,
      usage: typeof tokens,
      dollars: number,
      billing?: "codium",
    ) => ({
      info: {
        id,
        role: "assistant",
        sessionID,
        parentID: "msg_u",
        agent: "build",
        mode: "build",
        ...provider,
        time: { created: time, completed: time + 1 },
        path: { cwd: directory, root: directory },
        cost: dollars,
        tokens: usage,
        finish: "stop",
        ...(billing ? { billing } : {}),
      },
      parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "The change is ready." }],
    })
    await mockVectorServer(page, {
      directory,
      project,
      provider: {
        all: [
          {
            id: "vector-plan",
            name: "Vector Codium",
            models: {
              coding: {
                id: "coding",
                name: "Codium coding",
                limit: { context: 200_000 },
                cost: { input: 0, output: 0 },
              },
            },
          },
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "own-coding": {
                id: "own-coding",
                name: "Own coding",
                limit: { context: 200_000 },
                cost: { input: 1, output: 3 },
              },
            },
          },
        ],
        connected: ["vector-plan", "openai"],
        default: model,
      },
      sessions: [
        {
          id: sessionID,
          title,
          directory,
          projectID: project.id,
          time: { created: 1, updated: 6 },
          cost,
          tokens,
          codiumSteps: 1,
          unpricedSteps: 1,
        },
      ],
      pageMessages: () => ({
        items: [
          {
            info: { id: "msg_u", role: "user", sessionID, agent: "build", model, time: { created: 1 } },
            parts: [{ id: "p_u", messageID: "msg_u", sessionID, type: "text", text: "Fix the total" }],
          },
          ...(mixed ? [assistant("msg_own", own, 2, tokens, cost)] : []),
          // Raw context counts remain in the message for the occupancy calculation, never in visible usage labels.
          assistant("msg_codium", model, 4, rawCodiumTokens, 0, "codium"),
        ],
      }),
    })
    await page.addInitScript((projectDirectory) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: projectDirectory, expanded: true }] },
          lastProject: { local: projectDirectory },
        }),
      )
    }, directory)
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expectSessionTitle(page, title)

    const pill = page.locator('[data-component="session-cost-readout"]')
    await expect(pill).toBeVisible()
    await expect(pill).not.toContainText(/99,?000|100,?000|200,?000|cost unknown|unpriced/i)
    if (mixed) {
      await expect(pill).toContainText("$0.12 + Codium")
      await expect(pill).toContainText("48.2k + Codium")
    } else {
      await expect(pill).toHaveText("Codium")
      await expect(pill).not.toContainText(/\d|\$/)
    }

    await pill.hover()
    const tooltip = page.locator('[data-component="tooltip-v2"]').filter({ hasText: "Session cost" })
    await expect(tooltip).toBeVisible()
    await expect(tooltip).not.toContainText(/99,?000|100,?000|200,?000|cost unknown|unpriced/i)
    if (mixed) {
      await expect(tooltip).toContainText("$0.12 + Codium")
      await expect(tooltip).toContainText("48,213 + Codium")
    } else {
      await expect(tooltip).not.toContainText(/\d|\$/)
      await expect(tooltip.getByText("Codium", { exact: true })).toHaveCount(2)
    }

    const context = page.getByRole("button", { name: "View context usage", exact: true }).first()
    await context.hover()
    const contextTip = page
      .locator('[data-component="tooltip-v2"]')
      .filter({ has: page.getByText("Usage", { exact: true }) })
    await expect(contextTip).toBeVisible()
    await expect(contextTip).toContainText("50%")
    await expect(contextTip).not.toContainText(/99,?000|100,?000|200,?000/)
    await context.click()
    const ledger = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Live task ledger", exact: true }) })
    await expect(ledger).toBeVisible()
    await expect(ledger).toContainText("50%")
    await expect(ledger.getByText("Context limit", { exact: true })).toHaveCount(0)
    await expect(ledger).not.toContainText(/99,?000|100,?000|200,?000|cost unknown|unpriced/i)
    if (mixed) {
      await expect(ledger).toContainText("$0.12 + Codium")
      await expect(ledger).toContainText("48,213 + Codium")
    } else {
      await expect(ledger).not.toContainText(/\$/)
      await expect(ledger.getByText("Codium", { exact: true })).toHaveCount(2)
      await expect(ledger.getByText("Input tokens", { exact: true })).toHaveCount(0)
      await expect(ledger.getByText("Output tokens", { exact: true })).toHaveCount(0)
    }
  })
}
