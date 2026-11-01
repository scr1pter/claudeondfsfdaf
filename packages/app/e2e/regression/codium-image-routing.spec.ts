import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/CodiumImageRouting"
const sessionID = "ses_codium_image_routing"
const project = { id: "project-codium-image-routing", worktree: directory, vcs: "git", name: "Codium image routing" }

const model = (id: string, name: string, providerID: string, image: boolean, reasoning = false) => ({
  id,
  name,
  providerID,
  limit: { context: 128000, output: 8000 },
  cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
  variants: {},
  capabilities: { toolcall: true, reasoning, input: { text: true, image }, output: { text: true } },
  modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
  tool_call: true,
})

// Image-capable Codium entries Vector never picks by itself: Codium Auto, one the plan does not include and a
// manual-only lane. Each reasons, so it would outrank a plain image model if routing ever let it through.
const excluded = {
  "vector/codium-auto": {
    ...model("vector/codium-auto", "Codium Auto", "vector-plan", true, true),
    codium: { auto: { floor: "codium/vision", default: "codium/vision", ceiling: "codium/vision" } },
  },
  "codium/locked-vision": {
    ...model("codium/locked-vision", "Codium Locked Vision", "vector-plan", true, true),
    codium: { locked: { plan: "vector-100", name: "Max" } },
  },
  "codium/long-vision": {
    ...model("codium/long-vision", "Codium Long Vision", "vector-plan", true, true),
    codium: { manualOnly: true },
  },
}
const vision = { "codium/vision": model("codium/vision", "Codium Vision", "vector-plan", true) }
const text = { "codium/text": model("codium/text", "Codium Text", "vector-plan", false) }

// The session page with a text-only model chosen, and every prompt it sends. `configured` is the model the config
// names; without it Vector chooses Maker Text, since it never chooses a Codium model by itself.
async function setup(page: Page, codium: Record<string, unknown>, configured?: string) {
  const prompts: unknown[] = []
  await mockVectorServer(page, {
    directory,
    project,
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "api",
          models: { "maker/text": model("maker/text", "Maker Text", "anthropic", false) },
        },
        { id: "vector-plan", name: "Vector Codium", source: "custom", models: codium },
      ],
      connected: ["anthropic", "vector-plan"],
      default: { anthropic: "maker/text", "vector-plan": "codium/vision" },
    },
    sessions: [
      {
        id: sessionID,
        title: "Codium image routing",
        directory,
        projectID: project.id,
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  if (configured)
    await page.route(/\/(?:global\/)?config(?:\?|$)/, (route) => route.fulfill({ json: { model: configured } }))
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
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
  await expectSessionTitle(page, "Codium image routing")
  return prompts
}

// Attaches a screenshot to the prompt and sends it.
async function sendImage(page: Page) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  )
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: png })
  await page.locator('[data-component="prompt-input"]').filter({ visible: true }).first().click()
  await page.keyboard.type("What is wrong in this screenshot?")
  await page.keyboard.press("Enter")
}

const picker = (page: Page) => page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()

test("an attached image never moves the prompt onto Vector Codium", async ({ page }) => {
  const prompts = await setup(page, { ...vision, ...excluded })
  await expect(picker(page)).toContainText("Maker Text")
  await sendImage(page)

  await expect(page.getByText("Vector never switches to Vector Codium on its own", { exact: false })).toBeVisible()
  await page.waitForTimeout(500)
  expect(prompts).toEqual([])
  await expect(picker(page)).toContainText("Maker Text")
})

test("on a Codium text model, an image moves the prompt only onto a Codium model Vector may pick", async ({ page }) => {
  const prompts = await setup(page, { ...text, ...vision, ...excluded }, "vector-plan/codium/text")
  await expect(picker(page)).toContainText("Codium Text")
  await sendImage(page)

  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({ model: { providerID: "vector-plan", modelID: "codium/vision" } })
  await expect(picker(page)).toContainText("Codium Vision")
})

test("on a Codium text model, Codium Auto, a locked model or a manual-only lane never takes an image", async ({
  page,
}) => {
  const prompts = await setup(page, { ...text, ...excluded }, "vector-plan/codium/text")
  await expect(picker(page)).toContainText("Codium Text")
  await sendImage(page)

  await expect(page.getByText("Connect an image-capable model")).toBeVisible()
  await page.waitForTimeout(500)
  expect(prompts).toEqual([])
  await expect(picker(page)).toContainText("Codium Text")
})
