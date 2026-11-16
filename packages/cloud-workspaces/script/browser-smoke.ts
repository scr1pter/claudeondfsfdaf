import { chromium, expect, type BrowserContext, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"

// This UI regression deliberately intercepts its backend. It proves browser/account
// continuity and the real page's controls, not deployment or a paid cloud execution.
const origin = new URL(process.env.VECTOR_WORKSPACES_TEST_URL ?? "http://127.0.0.1:3456")
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw new Error("The workspace browser fixture may run only against a local HTTP development server.")
const directory = process.env.VECTOR_WORKSPACES_TEST_OUTPUT ?? "/tmp/vector-cloud-workspaces-browser-smoke"
const accountID = "ae16a5bf-f887-42c3-a6e4-6610cfa182b8"
const sessionID = "ses_browser_saved"
const firstPrompt = "Find the repository entry point."
const firstReply = "Found src/index.ts in the repository."
const secondPrompt = "Run the test suite."
const secondReply = "The test suite passed after your approval."
const reviewedDigest = "a".repeat(64)
const publishedPullRequest = {
  url: "https://github.com/vector/example/pull/37",
  branch: "vector/workspace-095f49dd-c5a0-4d90-ad7c-36314f95d6c5",
  commit: "b".repeat(40),
}
const token = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: accountID, exp: Math.floor(Date.now() / 1000) + 3600, aud: "authenticated", role: "authenticated" })).toString("base64url")}.fixture-signature`
const fixtureUser = {
  id: accountID,
  aud: "authenticated",
  role: "authenticated",
  email: "workspace-fixture@example.invalid",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
}
const fixtureSession = {
  access_token: token,
  refresh_token: "fixture-refresh-token",
  token_type: "bearer",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  user: fixtureUser,
}
type SavedMessage = { info: Record<string, unknown>; parts: Record<string, unknown>[] }
const backend = {
  mode: "enabled" as "enabled" | "disabled" | "error",
  workspace: undefined as
    | {
        id: string
        repository: string
        branch: string
        title: string
        state: "running" | "stopped"
        createdAt: number
        updatedAt: number
        revision: number
      }
    | undefined,
  session: undefined as { id: string; title: string; time: { created: number; updated: number } } | undefined,
  messages: [] as SavedMessage[],
  permissions: [] as {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
    always: string[]
  }[],
  promptIDs: [] as string[],
  allocations: new Map<string, string>(),
  allocationRequests: 0,
  replies: [] as string[],
  authenticatedReads: 0,
  reviewRequests: 0,
  publishRequests: 0,
}
const pageErrors: string[] = []
const consoleErrors: string[] = []
const failedRequests: string[] = []
const blockedRequests: string[] = []
const fixtureRequests: string[] = []

function safeText(value: string) {
  return value
    .replaceAll(token, "[fixture access token]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[GitHub credential]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[JWT]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .slice(0, 12_000)
}

function requestPath(value: string) {
  const url = new URL(value)
  return safeText(`${url.origin}${url.pathname}`)
}

async function intercept(context: BrowserContext, signedIn = true) {
  // Keep the fixture's fabricated identity entirely inside the test. No test token
  // or test traffic is allowed to reach a real account or cloud service.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin.origin) {
      blockedRequests.push(requestPath(url.href))
      return route.abort("blockedbyclient")
    }
    return route.continue()
  })
  await context.route("**/api/auth/config", (route) => {
    fixtureRequests.push("auth/config")
    return route.fulfill({
      json: {
        available: true,
        url: "https://vector-workspaces-fixture.supabase.co",
        publishableKey: "fixture-public-key",
      },
    })
  })
  await context.route("https://vector-workspaces-fixture.supabase.co/auth/v1/**", (route) =>
    route.fulfill({ json: fixtureUser }),
  )
  await context.route("**/api/cloud-workspaces", gateway)
  if (signedIn)
    await context.addInitScript(
      ({ session, expectedOrigin }) => {
        if (location.origin !== expectedOrigin) return
        try {
          localStorage.setItem("sb-vector-workspaces-fixture-auth-token", JSON.stringify(session))
        } catch {
          throw new Error("The local workspace fixture could not seed its account storage.")
        }
      },
      { session: fixtureSession, expectedOrigin: origin.origin },
    )
  context.on("page", (page) => {
    page.on("pageerror", (error) => pageErrors.push(safeText(error.message)))
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(safeText(message.text()))
    })
    page.on("requestfailed", (request) =>
      failedRequests.push(`${requestPath(request.url())} ${safeText(request.failure()?.errorText ?? "failed")}`),
    )
  })
}

async function gateway(route: Route) {
  fixtureRequests.push(`gateway:${route.request().method()}`)
  expect(route.request().headers().authorization).toBe(`Bearer ${token}`)
  if (route.request().method() === "GET") {
    backend.authenticatedReads++
    if (backend.mode === "error")
      return route.fulfill({
        status: 503,
        json: { error: { message: "No cloud capacity is available. Please try later." } },
      })
    return route.fulfill({
      json: {
        enabled: backend.mode === "enabled",
        workspaces: backend.mode === "enabled" && backend.workspace ? [backend.workspace] : [],
      },
    })
  }
  const command: unknown = route.request().postDataJSON()
  if (!record(command)) throw new Error("The page sent an invalid fixture command.")
  fixtureRequests.push(`command:${String(command.action)}${typeof command.path === "string" ? `:${command.path}` : ""}`)
  if (command.action === "create") {
    expect(command.repository).toBe("vector/example")
    expect(command.branch).toBe("main")
    expect(typeof command.idempotencyKey).toBe("string")
    expect(command.githubToken).toBeUndefined()
    backend.workspace = {
      id: "095f49dd-c5a0-4d90-ad7c-36314f95d6c5",
      repository: "vector/example",
      branch: "main",
      title: "Example repository",
      state: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    }
    return route.fulfill({ json: { workspace: backend.workspace } })
  }
  if (command.action === "changes") {
    expect(command.workspaceId).toBe(backend.workspace?.id)
    if (!backend.workspace) throw new Error("No fixture workspace exists to review.")
    backend.workspace = { ...backend.workspace, state: "stopped", revision: backend.workspace.revision + 1 }
    backend.reviewRequests++
    return route.fulfill({
      json: {
        workspace: backend.workspace,
        changes: {
          digest: reviewedDigest,
          diff: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const ready = false\n+export const ready = true\n",
          files: ["src/index.ts"],
        },
      },
    })
  }
  if (command.action === "publish") {
    expect(command.workspaceId).toBe(backend.workspace?.id)
    expect(command.digest).toBe(reviewedDigest)
    expect(command.title).toBe("Fix the repository entry point")
    expect(command.githubToken).toBe("fixture_github_token_for_browser")
    expect(backend.workspace?.state).toBe("stopped")
    backend.publishRequests++
    return route.fulfill({ json: { workspace: backend.workspace, pullRequest: publishedPullRequest } })
  }
  if (command.action !== "engine" || command.workspaceId !== backend.workspace?.id)
    throw new Error(`Unexpected fixture workspace command: ${String(command.action)}`)
  if (command.path === "/provider")
    return route.fulfill({
      json: {
        all: [
          {
            id: "vector-cloud",
            name: "Fixture gateway",
            models: { "fixture-model": { id: "fixture-model", name: "Fixture coding model" } },
          },
        ],
        default: { "vector-cloud": "fixture-model" },
        connected: ["vector-cloud"],
      },
    })
  if (command.path === "/session?roots=true&limit=50")
    return route.fulfill({ json: backend.session ? [backend.session] : [] })
  if (command.path === "/session/status")
    return route.fulfill({ json: backend.permissions.length ? { [sessionID]: { type: "busy" } } : {} })
  if (command.path === "/permission") return route.fulfill({ json: backend.permissions })
  if (command.path === "/question") return route.fulfill({ json: [] })
  if (command.path === `/session/${sessionID}/message?limit=100`) return route.fulfill({ json: backend.messages })
  if (command.path === "/session" && command.method === "POST") {
    if (!record(command.body) || typeof command.body.title !== "string")
      throw new Error("The page did not title its saved chat.")
    backend.session = { id: sessionID, title: command.body.title, time: { created: Date.now(), updated: Date.now() } }
    return route.fulfill({ json: backend.session })
  }
  if (command.path === `/session/${sessionID}/message_id` && command.method === "POST") {
    if (
      !record(command.body) ||
      typeof command.body.requestID !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(command.body.requestID)
    )
      throw new Error("The page did not allocate its message using a stable request UUID.")
    backend.allocationRequests++
    const existing = backend.allocations.get(command.body.requestID)
    const messageID = existing ?? `msg_${String(backend.allocations.size + 1).padStart(12, "0")}${"0".repeat(14)}`
    backend.allocations.set(command.body.requestID, messageID)
    return route.fulfill({ json: { messageID } })
  }
  if (command.path === `/session/${sessionID}/prompt_async` && command.method === "POST") {
    if (
      !record(command.body) ||
      typeof command.body.messageID !== "string" ||
      !Array.isArray(command.body.parts) ||
      !record(command.body.parts[0]) ||
      typeof command.body.parts[0].text !== "string"
    )
      throw new Error("The page sent an invalid fixture prompt.")
    expect(command.body.model).toEqual({ providerID: "vector-cloud", modelID: "fixture-model" })
    expect(command.body.messageID).toMatch(/^msg_[A-Za-z0-9]{26}$/)
    expect([...backend.allocations.values()]).toContain(command.body.messageID)
    expect(backend.promptIDs).not.toContain(command.body.messageID)
    backend.promptIDs.push(command.body.messageID)
    const text = command.body.parts[0].text
    backend.messages.push({
      info: { id: command.body.messageID, sessionID, role: "user", time: { created: Date.now() } },
      parts: [{ id: `prt_user_${backend.promptIDs.length}`, type: "text", text }],
    })
    if (text === firstPrompt) {
      backend.messages.push({
        info: {
          id: `${command.body.messageID.slice(0, -1)}1`,
          sessionID,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [
          { id: "prt_first_reply", type: "text", text: firstReply },
          {
            id: "prt_first_tool",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              title: "Inspect repository",
              output: "src/index.ts",
              input: {},
              time: { start: Date.now(), end: Date.now() },
            },
          },
        ],
      })
    } else {
      expect(text).toBe(secondPrompt)
      backend.permissions.push({
        id: "per_browser_once",
        sessionID,
        permission: "bash",
        patterns: ["bun test"],
        metadata: {},
        always: ["*"],
      })
    }
    return route.fulfill({ status: 204, body: "" })
  }
  if (command.path === "/permission/per_browser_once/reply") {
    expect(command.body).toEqual({ reply: "once" })
    backend.replies.push("once")
    backend.permissions = []
    backend.messages.push({
      info: {
        id: `${backend.promptIDs.at(-1)?.slice(0, -1)}1`,
        sessionID,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
      },
      parts: [{ id: "prt_second_reply", type: "text", text: secondReply }],
    })
    return route.fulfill({ json: true })
  }
  if (command.path === `/session/${sessionID}/abort`) return route.fulfill({ json: true })
  throw new Error(`Unexpected fixture engine path: ${String(command.path)}`)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

await fs.mkdir(directory, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VECTOR_WORKSPACES_CHROMIUM_PATH
    ? { executablePath: process.env.VECTOR_WORKSPACES_CHROMIUM_PATH }
    : {}),
})
try {
  const first = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await intercept(first)
  const page = await first.newPage()
  await page.goto(new URL("/workspaces", origin).href, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Code from anywhere." })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "New workspace", exact: true }).last().click()
  await page.getByLabel("GitHub repository", { exact: true }).fill("vector/example")
  await page.getByLabel(/Branch or ref/).fill("main")
  await page.getByRole("button", { name: "Create workspace", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Example repository", exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel("Model", { exact: true })).toContainText("Fixture coding model", { timeout: 15_000 })
  await page.getByLabel("Message Vector", { exact: true }).fill(firstPrompt)
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByText(firstReply, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Inspect repository", { exact: true })).toBeVisible()
  const savedURL = page.url()
  expect(new URL(savedURL).searchParams.get("workspace")).toBe("095f49dd-c5a0-4d90-ad7c-36314f95d6c5")
  expect(new URL(savedURL).searchParams.get("session")).toBe(sessionID)
  await page.screenshot({ path: path.join(directory, "workspace-desktop.png"), fullPage: true })
  await first.close()

  // A fresh browser context has no chat cache or shared localStorage with the first.
  // Only its fixture sign-in and the backend's persisted rows are re-established.
  const second = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await intercept(second)
  const mobile = await second.newPage()
  await mobile.goto(savedURL, { waitUntil: "domcontentloaded" })
  await expect(mobile.getByText(firstReply, { exact: true })).toBeVisible({ timeout: 15_000 })
  expect(backend.promptIDs).toHaveLength(1)
  await mobile.getByLabel("Message Vector", { exact: true }).fill(secondPrompt)
  await mobile.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(mobile.getByRole("heading", { name: "Allow bash?", exact: true })).toBeVisible({ timeout: 15_000 })
  expect(await mobile.getByRole("button", { name: /always/i }).count()).toBe(0)
  await mobile.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(mobile.getByText(secondReply, { exact: true })).toBeVisible({ timeout: 15_000 })
  expect(backend.promptIDs).toHaveLength(2)
  expect(new Set(backend.promptIDs).size).toBe(2)
  expect(backend.allocationRequests).toBe(2)
  expect(backend.allocations.size).toBe(2)
  expect(backend.replies).toEqual(["once"])
  await mobile.getByRole("button", { name: "Pause and review changes", exact: true }).click()
  await expect(mobile.getByLabel("Reviewed diff", { exact: true })).toContainText("+export const ready = true", {
    timeout: 15_000,
  })
  await expect(mobile.getByRole("button", { name: "Publish draft pull request", exact: true })).toBeDisabled()
  await mobile.getByLabel("Pull request title", { exact: true }).fill("Fix the repository entry point")
  await mobile.getByLabel("GitHub access token", { exact: true }).fill("fixture_github_token_for_browser")
  await mobile.getByRole("button", { name: "Publish draft pull request", exact: true }).click()
  await expect(mobile.getByRole("link", { name: "Open draft pull request", exact: true })).toHaveAttribute(
    "href",
    publishedPullRequest.url,
    { timeout: 15_000 },
  )
  expect(backend.reviewRequests).toBe(1)
  expect(backend.publishRequests).toBe(1)
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mobile.screenshot({ path: path.join(directory, "workspace-mobile-restored.png"), fullPage: true })

  backend.mode = "disabled"
  await mobile.reload({ waitUntil: "domcontentloaded" })
  await expect(
    mobile.getByRole("heading", { name: "Cloud workspaces aren’t available yet.", exact: true }),
  ).toBeVisible({ timeout: 15_000 })
  expect(await mobile.getByRole("button", { name: "Create workspace", exact: true }).count()).toBe(0)
  backend.mode = "error"
  await mobile.reload({ waitUntil: "domcontentloaded" })
  await expect(mobile.getByRole("alert")).toContainText("No cloud capacity is available. Please try later.", {
    timeout: 15_000,
  })
  await second.close()

  const signedOut = await browser.newContext()
  await intercept(signedOut, false)
  const before = backend.authenticatedReads
  const door = await signedOut.newPage()
  await door.goto(savedURL, { waitUntil: "domcontentloaded" })
  await expect(door.getByRole("link", { name: "Sign in to Vector", exact: true })).toBeVisible({ timeout: 15_000 })
  // The public page says the pilot is closed instead of reading as a launched product.
  await expect(door.getByRole("heading", { name: "Cloud workspaces are a private pilot.", exact: true })).toBeVisible()
  expect(backend.authenticatedReads).toBe(before)
  await signedOut.close()
  expect(pageErrors).toEqual([])
  const receipt = {
    kind: "cloud-workspace-ui-fixture",
    passed: true,
    scope: "Test-only intercepted backend; no actual hosted compute, GitHub publication or production account claim",
    checks: [
      "authenticated-create",
      "server-allocated-canonical-message-ids",
      "saved-session-and-prompt",
      "fresh-context-mobile-history",
      "follow-up",
      "allow-once",
      "pause-and-review-diff",
      "digest-bound-draft-pr-command",
      "verified-pr-response-link",
      "responsive-width",
      "disabled-service",
      "unavailable-service",
      "signed-out-gate",
    ],
    allocationRequests: backend.allocationRequests,
    allocatedMessages: backend.allocations.size,
    promptRequests: backend.promptIDs.length,
    permissionReplies: backend.replies,
    reviewRequests: backend.reviewRequests,
    publishRequests: backend.publishRequests,
    screenshots: ["workspace-desktop.png", "workspace-mobile-restored.png"],
  }
  await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  console.log(JSON.stringify(receipt))
} catch (cause) {
  const pages: { url: string; title: string; body: string; screenshot?: string }[] = []
  for (const [index, page] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries()) {
    if (page.isClosed()) continue
    const screenshot = path.join(directory, `failure-${index + 1}.png`)
    const captured = await page
      .screenshot({ path: screenshot, fullPage: true, timeout: 5000 })
      .then(() => screenshot)
      .catch(() => undefined)
    pages.push({
      url: requestPath(page.url()),
      title: safeText(await page.title().catch(() => "unavailable")),
      body: safeText(
        await page
          .locator("body")
          .innerText({ timeout: 3000 })
          .catch(() => "unavailable"),
      ),
      ...(captured ? { screenshot: captured } : {}),
    })
  }
  const failure = {
    kind: "cloud-workspace-ui-fixture-failure",
    error: safeText(cause instanceof Error ? cause.message : String(cause)),
    pages,
    pageErrors,
    consoleErrors,
    failedRequests,
    blockedRequests,
    fixtureRequests,
  }
  await fs.writeFile(path.join(directory, "failure.json"), JSON.stringify(failure, null, 2) + "\n")
  console.error(JSON.stringify(failure))
  throw cause
} finally {
  await browser.close()
}
