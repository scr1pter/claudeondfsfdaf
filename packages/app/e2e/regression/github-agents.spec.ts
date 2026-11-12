import { expect, test, type Page } from "@playwright/test"

type Fixture = {
  calls: [string, unknown?][]
  switchRepository(): void
  releasePreview?: () => void
}
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { githubAgentsFixture: Fixture }).githubAgentsFixture.calls)
const requests = async (page: Page, name: string) => (await calls(page)).filter(([method]) => method === name)

test("workflow permission recovery refreshes setup and its enclosing GitHub view after sign-in", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?signedIn=off&workflow=missing&listed=off")
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click()
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click()
  await expect(page.getByRole("button", { name: "Preview workflow", exact: true })).toBeEnabled()
  expect((await requests(page, "authStart"))[0][1]).toEqual({ workflow: true })
  expect(await requests(page, "authRefreshed")).toHaveLength(1)
  expect(await requests(page, "status")).toHaveLength(2)
  await page.getByRole("button", { name: "Update GitHub permissions", exact: true }).click()
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click()
  await expect.poll(async () => (await requests(page, "authRefreshed")).length).toBe(2)
  expect((await requests(page, "authStart"))[1][1]).toEqual({ workflow: true })
})

test("free own-key setup previews the exact workflow and never reads Codium bindings or Brain", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?workflow=missing&listed=off&manager=1")
  await expect(page.getByText("Your own key works with a free Vector account.", { exact: false })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Run with" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect(page.getByLabel("Workflow preview")).toContainText("/repo/one own-key")
  await expect(page.getByText("VECTOR_CLI_TOKEN", { exact: true }).last()).toBeVisible()
  expect(await requests(page, "setup")).toHaveLength(0)
  await page.getByRole("button", { name: "Open setup pull request" }).click()
  expect(await requests(page, "setup")).toHaveLength(1)
  for (const name of ["bindings", "runs", "previewBrain", "returnedArtifacts", "previewReturned", "importReturned"])
    expect(await requests(page, name)).toHaveLength(0)
})

test("a changed setup input or repository invalidates the preview and ignores late results", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?workflow=missing&listed=off")
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect(page.getByLabel("Workflow preview")).toBeVisible()
  await page.getByLabel("Provider/model").fill("openrouter/another")
  await expect(page.getByLabel("Workflow preview")).toHaveCount(0)
  await page.goto("/e2e/fixtures/github-agents.html?workflow=missing&listed=off&pending=1")
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect.poll(async () => (await requests(page, "preview")).length).toBe(1)
  await page.evaluate(() => {
    const fixture = (window as unknown as { githubAgentsFixture: Fixture }).githubAgentsFixture
    fixture.switchRepository()
    fixture.releasePreview?.()
  })
  await expect(page.getByRole("button", { name: "Preview workflow", exact: true })).toBeEnabled()
  await expect(page.getByLabel("Workflow preview")).toHaveCount(0)
  expect(await requests(page, "setup")).toHaveLength(0)
})

test("Codium and no-secret copy follow separate listing flags, and old CLI and read-only access refuse mutations", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&workflow=missing&noSecret=off")
  await expect(page.getByRole("option", { name: "Codium (your plan)", exact: true })).toHaveCount(1)
  await expect(page.getByRole("option", { name: /no key/ })).toHaveCount(0)
  await page.getByRole("combobox", { name: "Run with" }).selectOption("codium")
  await expect(page.getByLabel("Review pull requests automatically")).toHaveCount(0)
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  const preview = (await requests(page, "preview"))[0][1] as {
    mode: string
    autoReview: boolean
    share: boolean
    keys?: string[]
  }
  expect(preview).toMatchObject({ mode: "codium", autoReview: false, share: false })
  expect(preview.keys).toBeUndefined()
  await page.goto("/e2e/fixtures/github-agents.html?workflow=cli-too-old")
  await expect(page.getByText("Update Vector and its CLI before changing or running this workflow.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Preview workflow", exact: true })).toBeDisabled()
  await page.goto("/e2e/fixtures/github-agents.html?writer=off")
  await expect(page.getByRole("button", { name: "Run in GitHub", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Preview workflow", exact: true })).toBeDisabled()
})

test("Brain starts unchecked, shows readable exact content and sends only the approved opaque preview", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&public=1")
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Run in GitHub", exact: true })
  await expect(dialog).toContainText("42 minutes")
  await expect(dialog).toContainText("This repository is public: its Actions logs are public.")
  await dialog.getByLabel("What should Vector do?").fill("Fix the auth test")
  const include = dialog.getByLabel("Include repository Brain for this run")
  await expect(include).not.toBeChecked()
  expect(await requests(page, "previewBrain")).toHaveLength(0)
  await include.check()
  await expect(dialog.getByRole("button", { name: "Start run", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Preview Brain", exact: true }).click()
  await expect(dialog.getByLabel("Brain preview", { exact: true })).toContainText("Inspect auth tests before editing")
  await expect(dialog).toContainText("a".repeat(64))
  await dialog.getByLabel("I approve this exact Brain content for this repository and this run.").check()
  await page.screenshot({ path: testInfo.outputPath("github-run-approved-preview.png") })
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  await expect(dialog.getByRole("status")).toContainText("Run dispatched")
  expect((await requests(page, "run"))[0][1]).toEqual({
    cwd: "/repo/one",
    prompt: "Fix the auth test",
    brain: { previewId: "preview-/repo/one", approvedSha256: "a".repeat(64) },
  })
})

test("Brain approval resets with a new preview, failed run, and repository change", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&failRun=1")
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Run in GitHub", exact: true })
  await dialog.getByLabel("What should Vector do?").fill("Check auth")
  await dialog.getByLabel("Include repository Brain for this run").check()
  await dialog.getByRole("button", { name: "Preview Brain", exact: true }).click()
  const approval = dialog.getByLabel("I approve this exact Brain content for this repository and this run.")
  await approval.check()
  await dialog.getByRole("button", { name: "Preview Brain", exact: true }).click()
  await expect(approval).not.toBeChecked()
  await approval.check()
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(approval).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Start run", exact: true })).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as { githubAgentsFixture: Fixture }).githubAgentsFixture.switchRepository(),
  )
  await expect(dialog).toHaveCount(0)
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  await expect(page.getByLabel("Include repository Brain for this run")).not.toBeChecked()
  expect(await requests(page, "run")).toHaveLength(1)
})

test("own-key run has no Brain controls and stays stateless with Codium listed", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?manager=1")
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Run in GitHub", exact: true })
  await expect(dialog.getByLabel("Include repository Brain for this run")).toHaveCount(0)
  await dialog.getByLabel("What should Vector do?").fill("Fix the test")
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  await expect.poll(async () => (await requests(page, "run")).length).toBe(1)
  expect((await requests(page, "run"))[0][1]).toEqual({ cwd: "/repo/one", prompt: "Fix the test" })
  for (const name of ["bindings", "runs", "previewBrain", "returnedArtifacts", "previewReturned", "importReturned"])
    expect(await requests(page, name)).toHaveLength(0)
})

test("bindings hide lost-access names and returned Brain imports require preview and digest approval", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1")
  await expect(page.getByText("Repository access changed")).toBeVisible()
  await expect(page.locator("body")).not.toContainText("must-not-show")
  expect(await requests(page, "returnedArtifacts")).toHaveLength(0)
  await page.getByRole("button", { name: "Find returned Brain proposals" }).click()
  await page.getByRole("button", { name: "Preview vector-session-7" }).click()
  await expect(page.getByLabel("Returned Brain preview")).toContainText("Proposed draft, not active memory")
  await expect(page.getByRole("button", { name: "Import as proposals" })).toBeDisabled()
  expect(await requests(page, "importReturned")).toHaveLength(0)
  await page
    .getByLabel("Queue this exact content as proposals for this repository. Review is required before applying it.")
    .check()
  await page.getByRole("button", { name: "Import as proposals" }).click()
  await expect(page.getByRole("status")).toContainText("1 proposals queued for review")
  expect((await requests(page, "importReturned"))[0][1]).toEqual({
    previewId: "returned-preview",
    approvedSha256: "a".repeat(64),
  })
})

test("GitHub scheduling opens an update PR without also creating a local automation", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?view=automations&mode=own-key&listed=off")
  await page.getByRole("button", { name: "New automation", exact: true }).click()
  await page.getByLabel("What should Vector do, every time?").fill("Check dependencies")
  const remote = page.getByLabel("Run in GitHub Actions when this computer is off", { exact: false })
  await expect(remote).toBeVisible()
  await remote.check()
  await expect(page.getByText("GitHub schedules are best effort.", { exact: false })).toBeVisible()
  await page.getByRole("button", { name: "Open schedule update pull request", exact: true }).click()
  await expect(page.getByRole("link", { name: "Open schedule update pull request" })).toBeVisible()
  expect(await requests(page, "schedules")).toHaveLength(1)
  expect(await requests(page, "localCreate")).toHaveLength(0)
  await page.getByLabel("Repeat", { exact: true }).selectOption("once")
  await expect(remote).toHaveCount(0)
  await page.goto("/e2e/fixtures/github-agents.html?view=automations&mode=codium&scheduled=off")
  await page.getByRole("button", { name: "New automation", exact: true }).click()
  await expect(page.getByLabel("Run in GitHub Actions when this computer is off", { exact: false })).toHaveCount(0)
})
