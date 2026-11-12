import { expect, test, type Page } from "@playwright/test"

type Fixture = {
  calls: [string, unknown?][]
  switchRepository(): void
  switchRemote(): void
  switchAccount(): void
  signOut(): void
  codiumChanged(): void
  release(name: string): void
  releasePreview?: () => void
}
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { githubAgentsFixture: Fixture }).githubAgentsFixture.calls)
const requests = async (page: Page, name: string) => (await calls(page)).filter(([method]) => method === name)
const signal = (page: Page, name: "switchAccount" | "signOut" | "codiumChanged" | "switchRemote") =>
  page.evaluate((name) => (window as unknown as { githubAgentsFixture: Fixture }).githubAgentsFixture[name](), name)
const release = (page: Page, name: string) =>
  page.evaluate(
    (name) => (window as unknown as { githubAgentsFixture: Fixture }).githubAgentsFixture.release(name),
    name,
  )

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
  await expect(dialog).toContainText(
    "Vector stores the encrypted attachment and a wrapped key for up to two hours; the authorized GitHub run decrypts the content.",
  )
  await expect(dialog.getByRole("button", { name: "Start run", exact: true })).toBeDisabled()
  await dialog.getByRole("button", { name: "Preview Brain", exact: true }).click()
  await expect(dialog.getByLabel("Brain preview", { exact: true })).toContainText("Inspect auth tests before editing")
  await expect(dialog).toContainText("a".repeat(64))
  await dialog.getByLabel("I approve this exact Brain content for this repository and this run.").check()
  await page.screenshot({ path: testInfo.outputPath("github-run-approved-preview.png") })
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  await expect(dialog.getByRole("status")).toContainText("Run dispatched")
  expect((await requests(page, "run"))[0][1]).toMatchObject({
    cwd: "/repo/one",
    expectedRepositoryId: "17",
    authorityId: "authority-owner-17-on",
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
  await expect(dialog.getByRole("alert")).toContainText("Vector does not resend automatically.")
  expect(await requests(page, "run")).toHaveLength(1)
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
  expect((await requests(page, "run"))[0][1]).toMatchObject({
    cwd: "/repo/one",
    expectedRepositoryId: "17",
    authorityId: "authority-owner-17-on",
    prompt: "Fix the test",
  })
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
    previewId: "returned-preview-owner",
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

test("a delayed status from the previous account cannot replace the new account at the same directory", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&pendingStatus=1")
  await expect.poll(async () => (await requests(page, "status")).length).toBe(1)
  await signal(page, "switchAccount")
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  await release(page, "status")
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  await expect(page.locator("body")).not.toContainText("Ready in owner/one")
})

for (const event of ["switchAccount", "codiumChanged"] as const) {
  test(`${event} immediately removes plaintext Brain and approval from an open run`, async ({ page }) => {
    await page.goto("/e2e/fixtures/github-agents.html?mode=codium")
    await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
    await page.getByLabel("Include repository Brain for this run").check()
    await page.getByRole("button", { name: "Preview Brain", exact: true }).click()
    await expect(page.getByLabel("Brain preview", { exact: true })).toContainText("owner-Brain-secret")
    await page.getByLabel("I approve this exact Brain content for this repository and this run.").check()
    await signal(page, event)
    await expect(page.getByRole("dialog", { name: "Run in GitHub", exact: true })).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText("owner-Brain-secret")
    await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
    await expect(page.getByLabel("Include repository Brain for this run")).not.toBeChecked()
    expect(await requests(page, "run")).toHaveLength(0)
  })
}

test("old account binding, history and Brain responses are retired even when they finish later", async ({ page }) => {
  await page.goto(
    "/e2e/fixtures/github-agents.html?mode=codium&manager=1&pendingBindings=1&pendingRuns=1&pendingBrain=1",
  )
  await expect.poll(async () => (await requests(page, "bindings")).length).toBe(1)
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  await page.getByLabel("Include repository Brain for this run").check()
  await page.getByRole("button", { name: "Preview Brain", exact: true }).click()
  await expect.poll(async () => (await requests(page, "previewBrain")).length).toBe(1)
  await signal(page, "switchAccount")
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  for (const name of ["bindings", "runs", "brain"]) await release(page, name)
  await expect(page.locator("body")).not.toContainText("owner-Brain-secret")
  await expect(page.locator("body")).not.toContainText("owner/one")
  await expect(page.getByRole("dialog", { name: "Run in GitHub", exact: true })).toHaveCount(0)
  expect(await requests(page, "run")).toHaveLength(0)
})

test("sign-out immediately clears returned plaintext, approval and unbind confirmation", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1")
  await page.getByRole("button", { name: "Find returned Brain proposals" }).click()
  await page.getByRole("button", { name: "Preview vector-session-7" }).click()
  await expect(page.getByLabel("Returned Brain preview")).toContainText("owner-returned-secret")
  await page
    .getByLabel("Queue this exact content as proposals for this repository. Review is required before applying it.")
    .check()
  await page.getByRole("button", { name: "Unbind", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "Confirm unbind" })).toBeVisible()
  await signal(page, "signOut")
  await expect(page.locator("body")).not.toContainText("owner-returned-secret")
  await expect(page.getByRole("button", { name: "Import as proposals" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Confirm unbind" })).toHaveCount(0)
  expect(await requests(page, "importReturned")).toHaveLength(0)
  expect(await requests(page, "unbind")).toHaveLength(0)
})

test("a delayed returned preview cannot reappear after switching accounts", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1&pendingReturned=1")
  await page.getByRole("button", { name: "Find returned Brain proposals" }).click()
  await page.getByRole("button", { name: "Preview vector-session-7" }).click()
  await expect.poll(async () => (await requests(page, "previewReturned")).length).toBe(1)
  await signal(page, "switchAccount")
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  await release(page, "returned")
  await expect(page.getByLabel("Returned Brain preview")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("owner-returned-secret")
  expect(await requests(page, "importReturned")).toHaveLength(0)
})

test("checking a changed remote at the same directory retires its old preview and binds the new effect to its verified ID", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?workflow=missing&listed=off")
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect(page.getByLabel("Workflow preview")).toContainText("repository 17")
  await signal(page, "switchRemote")
  await page.getByRole("button", { name: "Check again", exact: true }).click()
  await expect(page.getByLabel("Workflow preview")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect(page.getByLabel("Workflow preview")).toContainText("repository 19")
  await page.getByRole("button", { name: "Open setup pull request" }).click()
  expect((await requests(page, "setup"))[0][1]).toMatchObject({
    expectedRepositoryId: "19",
    authorityId: "authority-owner-19-on",
  })
})

test("an old account's delayed workflow preview cannot enable setup for the next account", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?workflow=missing&listed=off&pending=1")
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await expect.poll(async () => (await requests(page, "preview")).length).toBe(1)
  await signal(page, "switchAccount")
  await expect(page.getByRole("button", { name: "Preview workflow", exact: true })).toBeEnabled()
  await release(page, "preview")
  await expect(page.getByLabel("Workflow preview")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open setup pull request" })).toHaveCount(0)
  expect(await requests(page, "setup")).toHaveLength(0)
})

for (const binding of ["unavailable", "suspended"] as const) {
  test(`an owned ${binding} Codium binding disables Run and offers repair guidance`, async ({ page }) => {
    await page.goto(`/e2e/fixtures/github-agents.html?mode=codium&binding=${binding}`)
    await expect(page.getByRole("heading", { name: "Codium is unavailable for this binding" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Run in GitHub", exact: true })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Preview workflow", exact: true })).toBeEnabled()
    expect(await requests(page, "run")).toHaveLength(0)
  })
}

test("a pending run cannot be dismissed and reopened to send another Start", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?pendingRun=1&listed=off")
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Run in GitHub", exact: true })
  await dialog.getByLabel("What should Vector do?").fill("Fix the test")
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  expect(await requests(page, "run")).toHaveLength(1)
  await release(page, "run")
  await expect(dialog.getByRole("status")).toContainText("Run dispatched")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test("one dialog keeps the same operation ID for an explicit retry after an uncertain start", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?failRun=1&listed=off")
  await page.getByRole("button", { name: "Run in GitHub", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Run in GitHub", exact: true })
  await dialog.getByLabel("What should Vector do?").fill("Fix the test")
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await dialog.getByRole("button", { name: "Start run", exact: true }).click()
  const effects = await requests(page, "run")
  expect(effects).toHaveLength(2)
  expect((effects[1][1] as { operationId: string }).operationId).toBe(
    (effects[0][1] as { operationId: string }).operationId,
  )
  expect((effects[0][1] as { operationId: string }).operationId).toMatch(/^[0-9a-f-]{36}$/)
})

test("a delayed schedule PR does not appear as the result of edited recurrence and prompt", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?view=automations&listed=off&pendingSchedule=1")
  await page.getByRole("button", { name: "New automation", exact: true }).click()
  await page.getByLabel("What should Vector do, every time?").fill("Old task")
  await page.getByLabel("Run in GitHub Actions when this computer is off", { exact: false }).check()
  await page.getByRole("button", { name: "Open schedule update pull request", exact: true }).click()
  await expect.poll(async () => (await requests(page, "schedules")).length).toBe(1)
  await page.getByLabel("What should Vector do, every time?").fill("New task")
  await page.getByLabel("Time", { exact: true }).fill("10:15")
  await release(page, "schedules")
  await expect(page.getByRole("button", { name: "Open schedule update pull request", exact: true })).toBeEnabled()
  await expect(page.getByRole("link", { name: "Open schedule update pull request" })).toHaveCount(0)
  await page.getByRole("button", { name: "Open schedule update pull request", exact: true }).click()
  const effects = await requests(page, "schedules")
  expect(effects).toHaveLength(2)
  expect(effects[1][1]).toMatchObject({
    expectedRepositoryId: "17",
    authorityId: "authority-owner-17-on",
    schedules: [expect.objectContaining({ prompt: "New task" })],
  })
  expect((effects[1][1] as { operationId: string }).operationId).not.toBe(
    (effects[0][1] as { operationId: string }).operationId,
  )
  expect(await requests(page, "localCreate")).toHaveLength(0)
})

test("an old account's pending schedule result is retired without a local fallback", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?view=automations&listed=off&pendingSchedule=1")
  await page.getByRole("button", { name: "New automation", exact: true }).click()
  await page.getByLabel("What should Vector do, every time?").fill("Check dependencies")
  const checkbox = page.getByLabel("Run in GitHub Actions when this computer is off", { exact: false })
  await checkbox.check()
  await page.getByRole("button", { name: "Open schedule update pull request", exact: true }).click()
  await expect.poll(async () => (await requests(page, "schedules")).length).toBe(1)
  await signal(page, "switchAccount")
  await release(page, "schedules")
  await expect(checkbox).not.toBeChecked()
  await expect(page.getByRole("link", { name: "Open schedule update pull request" })).toHaveCount(0)
  expect(await requests(page, "localCreate")).toHaveLength(0)
})

test("a binding without a current opaque row authority cannot be unbound", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1&rowAuthority=off")
  await expect(page.getByRole("button", { name: "Unbind", exact: true }).first()).toBeDisabled()
  await expect(page.getByText("Refresh GitHub access to manage this binding.").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirm unbind" })).toHaveCount(0)
  expect(await requests(page, "unbind")).toHaveLength(0)
})

test("an account switch clears unbind consent and the next owner sends only their displayed row authority", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1")
  await page.getByRole("button", { name: "Unbind", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "Confirm unbind" })).toBeVisible()
  await signal(page, "switchAccount")
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirm unbind" })).toHaveCount(0)
  expect(await requests(page, "unbind")).toHaveLength(0)
  await page.getByRole("button", { name: "Unbind", exact: true }).first().click()
  await page.getByRole("button", { name: "Confirm unbind" }).click()
  await expect.poll(async () => (await requests(page, "unbind")).length).toBe(1)
  const scope = (await requests(page, "unbind"))[0][1] as {
    repositoryId: string
    authorityId: string
    operationId: string
  }
  expect(scope).toMatchObject({ repositoryId: "17", authorityId: "binding-authority-other-17-on" })
  expect(scope.operationId).toMatch(/^[0-9a-f-]{36}$/)
})

test("an old owner's pending unbind response cannot refresh or repopulate the next account's binding view", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1&pendingUnbind=1")
  await page.getByRole("button", { name: "Unbind", exact: true }).first().click()
  await page.getByRole("button", { name: "Confirm unbind" }).click()
  await expect.poll(async () => (await requests(page, "unbind")).length).toBe(1)
  expect((await requests(page, "unbind"))[0][1]).toMatchObject({
    repositoryId: "17",
    authorityId: "binding-authority-owner-17-on",
  })
  await signal(page, "switchAccount")
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  await expect.poll(async () => (await requests(page, "bindings")).length).toBe(2)
  await release(page, "unbind")
  await expect.poll(async () => (await requests(page, "unbindReturned")).length).toBe(1)
  await expect(page.getByRole("heading", { name: "Ready in other/one" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirm unbind" })).toHaveCount(0)
  expect(await requests(page, "bindings")).toHaveLength(2)
})

test("retrying the same displayed unbind confirmation preserves its operation ID and row authority", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&manager=1&failUnbind=1")
  await page.getByRole("button", { name: "Unbind", exact: true }).first().click()
  await page.getByRole("button", { name: "Confirm unbind" }).click()
  await expect(page.getByRole("alert")).toContainText("The disconnect result may be uncertain.")
  await expect(page.getByRole("alert")).toContainText("Vector does not resend automatically.")
  expect(await requests(page, "unbind")).toHaveLength(1)
  await page.getByRole("button", { name: "Confirm unbind" }).click()
  await expect.poll(async () => (await requests(page, "unbind")).length).toBe(2)
  const effects = await requests(page, "unbind")
  expect(effects[1][1]).toEqual(effects[0][1])
  expect(effects[0][1]).toMatchObject({
    repositoryId: "17",
    authorityId: "binding-authority-owner-17-on",
    operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  })
})

test("an uncertain setup directs the owner to pull requests and does not resend automatically", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?workflow=missing&listed=off&failSetup=1")
  await page.getByRole("button", { name: "Preview workflow", exact: true }).click()
  await page.getByRole("button", { name: "Open setup pull request" }).click()
  await expect(page.getByRole("alert")).toContainText(
    "The setup result may be uncertain. Check open pull requests before continuing.",
  )
  await expect(page.getByRole("alert")).toContainText("Vector does not resend automatically.")
  expect(await requests(page, "setup")).toHaveLength(1)
})

test("an uncertain bind directs the owner to Actions and retains the same explicit retry intent", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?mode=codium&bound=other&failBind=1")
  await page.getByRole("button", { name: "Bind repository", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("The connection result may be uncertain. Check its Actions run")
  await expect(page.getByRole("alert")).toContainText("Vector does not resend automatically.")
  expect(await requests(page, "bind")).toHaveLength(1)
  await page.getByRole("button", { name: "Bind repository", exact: true }).click()
  await expect.poll(async () => (await requests(page, "bind")).length).toBe(2)
  const effects = await requests(page, "bind")
  expect(effects[1][1]).toEqual(effects[0][1])
})

test("an uncertain schedule does not create a local fallback or resend the request", async ({ page }) => {
  await page.goto("/e2e/fixtures/github-agents.html?view=automations&listed=off&failSchedule=1")
  await page.getByRole("button", { name: "New automation", exact: true }).click()
  await page.getByLabel("What should Vector do, every time?").fill("Check dependencies")
  await page.getByLabel("Run in GitHub Actions when this computer is off", { exact: false }).check()
  await page.getByRole("button", { name: "Open schedule update pull request", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(
    "The schedule result may be uncertain. Check open pull requests before continuing.",
  )
  await expect(page.getByRole("alert")).toContainText("Vector does not resend automatically.")
  expect(await requests(page, "schedules")).toHaveLength(1)
  expect(await requests(page, "localCreate")).toHaveLength(0)
})
