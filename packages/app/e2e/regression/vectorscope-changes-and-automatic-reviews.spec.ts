import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/VectorscopeLocal"
const sessionID = "ses_vectorscope_local"
const project = { id: "project-vectorscope-local", worktree: directory, vcs: "git", name: "Vectorscope Local" }
const SECRETS_URL = "https://github.com/acme/app/settings/secrets/actions"
const WORKFLOW_URL = "https://github.com/acme/app/blob/main/.github/workflows/vector.yml"
const PULL_URL = "https://github.com/acme/app/pull/12"
const PREVIEW_INPUT = {
  cwd: directory,
  mode: "own-key",
  model: "anthropic/claude-sonnet-4-5",
  keys: ["ANTHROPIC_API_KEY"],
  autoReview: false,
  share: false,
}

type Agents = { signedIn: boolean; workflow: "missing" | "current"; autoReview: boolean }
type Calls = { status: unknown[]; preview: unknown[]; setup: unknown[]; start: unknown[] }

// The panel through the desktop bridge, signed in to GitHub with no open pull requests. Its GitHub workflow card reads
// the given repository workflow state; opening the setup pull request opens #12 and leaves it pending.
async function openVectorscope(page: Page, input: { changes?: () => unknown[]; agents?: Partial<Agents> }) {
  await mockVectorServer(page, {
    directory,
    project,
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "env",
          env: ["ANTHROPIC_API_KEY"],
          models: {
            "claude-sonnet-4-5": {
              id: "claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              cost: { input: 3, output: 15 },
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet-4-5" },
    },
    sessions: [
      { id: sessionID, title: "Vectorscope local", directory, projectID: project.id, time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
    ...(input.changes ? { vcsStatus: input.changes } : {}),
  })
  await page.addInitScript(
    (setup) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: setup.directory, expanded: true }] },
          lastProject: { local: setup.directory },
        }),
      )
      const calls = {
        status: [] as unknown[],
        preview: [] as unknown[],
        setup: [] as unknown[],
        start: [] as unknown[],
      }
      const agents = { ...setup.agents }
      const secrets = [
        {
          name: "VECTOR_CLI_TOKEN",
          detail: "Signs the workflow in to your Vector account.",
          url: "https://vectordev.ai/auth/cli",
        },
        { name: "ANTHROPIC_API_KEY", detail: "Your model provider's API key.", url: setup.secretsUrl },
      ]
      const listed = { agents: false, scheduled: false, noSecret: false, brain: false }
      Object.defineProperty(window, "__vectorscopeCalls", { value: calls })
      Object.defineProperty(window, "api", {
        configurable: true,
        value: {
          pullRequests: {
            status: async () => ({
              authenticated: true,
              configured: true,
              login: "mira",
              source: "vector",
              detail: "",
            }),
            list: async () => [],
          },
          // The same shape as e2e/fixtures/github-agents.jsx: a signed-out status carries no repository authority.
          githubAgents: {
            status: async (cwd: string) => {
              calls.status.push(cwd)
              if (!agents.signedIn)
                return {
                  signedIn: false,
                  canDispatch: false,
                  workflow: "missing",
                  listed,
                  bound: "not-yours-or-unknown",
                }
              return {
                repo: "acme/app",
                repositoryId: "17",
                authorityId: "authority-mira-17",
                defaultBranch: "main",
                publicRepository: false,
                signedIn: true,
                canDispatch: true,
                workflow: agents.workflow,
                listed,
                bound: "not-yours-or-unknown",
                ...(agents.workflow === "current"
                  ? {
                      options: {
                        mode: "own-key",
                        provider: "anthropic",
                        model: "claude-sonnet-4-5",
                        keys: ["ANTHROPIC_API_KEY"],
                        autoReview: agents.autoReview,
                        version: "1.99.113",
                        schedules: [],
                      },
                      url: setup.workflowUrl,
                      timeoutMinutes: 42,
                    }
                  : {}),
              }
            },
            preview: async (request: unknown) => {
              calls.preview.push(request)
              return {
                path: ".github/workflows/vector.yml",
                content: "name: Vector\n\non:\n  issue_comment:\n    types: [created]\n",
                secrets,
              }
            },
            setup: async (request: unknown) => {
              calls.setup.push(request)
              return { url: setup.pullUrl }
            },
          },
          ci: { runs: async () => ({ ok: true, runs: [] }) },
          github: {
            auth: {
              status: async () => ({ configured: true, authenticated: true }),
              start: async (input?: unknown) => {
                calls.start.push(input ?? null)
                return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
              },
              openVerification: async () => undefined,
              // GitHub authorizes the code when the test calls __authorizeGithub; the new sign-in may change workflows.
              complete: () =>
                new Promise((resolve) =>
                  Object.defineProperty(window, "__authorizeGithub", {
                    configurable: true,
                    value: () => {
                      agents.signedIn = true
                      resolve({ ok: true, login: "mira" })
                    },
                  }),
                ),
              cancel: async () => undefined,
              logout: async () => undefined,
            },
          },
        },
      })
    },
    {
      directory,
      agents: { signedIn: true, workflow: "missing", autoReview: false, ...input.agents },
      secretsUrl: SECRETS_URL,
      workflowUrl: WORKFLOW_URL,
      pullUrl: PULL_URL,
    },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Vectorscope local")
  await page.locator('[data-tour="nav-pull-requests"]').click()
  return page.getByRole("dialog", { name: "Vectorscope" })
}

function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { __vectorscopeCalls: Calls }).__vectorscopeCalls)
}

// The GitHub workflow card that replaced the automatic-reviews view, opened from the panel's sidebar.
async function openWorkflowCard(page: Page, panel: Awaited<ReturnType<typeof openVectorscope>>) {
  await panel.getByRole("button", { name: "GitHub workflow & runs", exact: true }).click()
  const card = panel.locator("[data-github-agents-setup]")
  await expect.poll(async () => (await calls(page)).status).toEqual([directory])
  return card
}

test("Vectorscope offers a review of uncommitted changes only when there are some", async ({ page }, testInfo) => {
  const changes: { file: string; additions: number; deletions: number; status: string }[] = []
  const panel = await openVectorscope(page, { changes: () => changes })

  const yours = panel.getByRole("button", { name: /Your changes/ })
  await expect(yours).toContainText("No uncommitted changes")
  await yours.click()
  await expect(panel.getByRole("heading", { name: "Your changes" })).toBeVisible()
  await expect(panel.getByText("Vectorscope reviews what you haven't committed yet")).toBeVisible()
  await expect(panel.getByRole("button", { name: "Review my changes" })).toHaveCount(0)

  changes.push(
    { file: "src/list.ts", additions: 3, deletions: 1, status: "modified" },
    { file: "src/total.ts", additions: 10, deletions: 0, status: "added" },
  )
  await panel.getByRole("button", { name: "Check again" }).click()
  await expect(yours).toContainText("2 uncommitted files · +13 −1")
  const review = panel.getByRole("region", { name: "AI review" })
  await expect(review).toContainText("Not reviewed yet")
  await expect(review).toContainText("Nothing is posted anywhere.")
  await expect(review.getByRole("button", { name: "Review my changes" })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath("your-changes.png") })
  await testInfo.attach("your-changes", { path: testInfo.outputPath("your-changes.png"), contentType: "image/png" })
})

test("Vectorscope opens the workflow setup pull request only after showing what it adds", async ({
  page,
}, testInfo) => {
  const panel = await openVectorscope(page, {})
  const card = await openWorkflowCard(page, panel)

  await expect(card).toContainText("Preview the exact workflow before opening a pull request.")
  await expect(card.getByLabel("Provider/model")).toHaveValue("anthropic/claude-sonnet-4-5")
  await expect(card.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  await card.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect(card.getByRole("heading", { name: ".github/workflows/vector.yml" })).toBeVisible()
  await expect(card.getByLabel("Workflow preview")).toContainText("issue_comment")
  await expect(card.getByText("VECTOR_CLI_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(card.getByText("ANTHROPIC_API_KEY", { exact: true }).last()).toBeVisible()
  await expect(card.getByRole("link", { name: "Open secrets" }).last()).toHaveAttribute("href", SECRETS_URL)
  expect((await calls(page)).preview).toEqual([PREVIEW_INPUT])
  expect((await calls(page)).setup).toEqual([])
  await page.screenshot({ path: testInfo.outputPath("confirm.png") })
  await testInfo.attach("confirm", { path: testInfo.outputPath("confirm.png"), contentType: "image/png" })

  await card.getByRole("button", { name: "Open setup pull request" }).click()
  await expect(card.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", PULL_URL)
  await expect(card).toContainText("Check and merge workflow changes before checking again.")
  expect((await calls(page)).setup).toEqual([
    { ...PREVIEW_INPUT, expectedRepositoryId: "17", authorityId: "authority-mira-17", operationId: expect.any(String) },
  ])
  await expect(card.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("opened.png") })
  await testInfo.attach("opened", { path: testInfo.outputPath("opened.png"), contentType: "image/png" })
})

test("Vectorscope says the workflow reviews every pull request instead of offering to set it up", async ({ page }) => {
  const panel = await openVectorscope(page, { agents: { workflow: "current", autoReview: true } })
  const card = await openWorkflowCard(page, panel)

  await expect(card).toContainText("Ready in acme/app")
  await expect(card).toContainText("Reviews every pull request.")
  await expect(card).not.toContainText("Reviews when someone comments")
  await expect(card.getByRole("link", { name: "View the workflow" })).toHaveAttribute("href", WORKFLOW_URL)
  await expect(card.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  expect((await calls(page)).preview).toEqual([])
})

test("Vectorscope asks for GitHub's workflow permission only to set up the workflow", async ({ page }) => {
  const panel = await openVectorscope(page, { agents: { signedIn: false } })
  const card = await openWorkflowCard(page, panel)

  await expect(card).toContainText("Sign in to GitHub to check your repository access.")
  await expect(card.getByRole("button", { name: "Preview workflow", exact: true })).toBeDisabled()
  expect((await calls(page)).start).toEqual([])
  await card.getByRole("button", { name: "Sign in to GitHub", exact: true }).click()
  await expect(card).toContainText("Approve GitHub access to set up this repository's workflow.")
  // The sign-in waits to be asked, and this one is the only one that asks for the workflow permission.
  expect((await calls(page)).start).toEqual([])
  await card.getByRole("button", { name: "Connect GitHub", exact: true }).click()
  await expect(card.getByText("WDJB-MJHT")).toBeVisible()
  await expect(card).toContainText("GitHub also asks to let Vector change workflow files")
  expect((await calls(page)).start).toEqual([{ workflow: true }])

  // Once GitHub authorizes it, the card checks the repository again and is ready to preview what it adds.
  await page.evaluate(() => (window as unknown as { __authorizeGithub: () => void }).__authorizeGithub())
  await expect(card.getByRole("button", { name: "Preview workflow", exact: true })).toBeEnabled()
  await expect(card.getByRole("button", { name: "Update GitHub permissions", exact: true })).toBeVisible()
  expect((await calls(page)).status).toEqual([directory, directory])
  expect((await calls(page)).start).toEqual([{ workflow: true }])
  expect((await calls(page)).preview).toEqual([])
})

test("Vectorscope says when the workflow only reviews on a /vector review comment", async ({ page }) => {
  const panel = await openVectorscope(page, { agents: { workflow: "current", autoReview: false } })
  const card = await openWorkflowCard(page, panel)

  await expect(card).toContainText("Ready in acme/app")
  await expect(card).toContainText("Reviews when someone comments /vector review.")
  await expect(card).not.toContainText("Reviews every pull request")
  await expect(card.getByRole("link", { name: "View the workflow" })).toHaveAttribute("href", WORKFLOW_URL)
  // Reviewing every pull request stays a choice in the workflow setup below.
  await expect(card.getByLabel("Review pull requests automatically")).not.toBeChecked()
  await expect(card.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  expect((await calls(page)).preview).toEqual([])
})
