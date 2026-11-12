import { expect, test, type Page, type Route } from "@playwright/test"
import { reviewRun } from "../../src/features/connect/test-fixture"
import { directory, rootID, setup } from "../utils/multiagent"

const isolated = `${directory}/isolated-fixture`
const workspaceID = "workspace-directory-review"
const base = "a".repeat(40)

function reply(route: Route, body: unknown, status = 200) {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "*",
  }
  return route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 204, headers })
    : route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) })
}

async function installNativeRecord(page: Page) {
  await page.addInitScript(
    ({ directory, rootID, isolated, workspaceID, base }) => {
      const record = {
        id: workspaceID,
        revision: 1,
        name: "Review the isolated parser",
        taskPrompt: "Implement the isolated parser",
        runtime: "vector",
        provider: "fixture",
        model: "fixture-model",
        sourcePath: directory,
        parentSessionId: rootID,
        isolatedPath: isolated,
        isolation: "git-worktree",
        gitBranch: "fixture-branch",
        baseCommit: base,
        status: "complete",
        progress: 100,
        lastAction: "Ready for review",
        createdAt: "2026-11-12T10:00:00.000Z",
        lastActivityAt: "2026-11-12T10:01:00.000Z",
        changedFilesCount: 1,
        riskLevel: "low",
        estimatedCost: "",
        finalSummary: "Parser implemented",
        mergeState: "none",
        logs: [],
        terminalOutput: [],
        browserResults: [],
        changedFiles: ["src/parser.ts"],
        diff: "",
      }
      Object.defineProperty(window, "api", {
        configurable: true,
        value: { parallelWorkspaces: { list: async () => [structuredClone(record)] } },
      })
    },
    { directory, rootID, isolated, workspaceID, base },
  )
}

function runningRun() {
  const fixture = reviewRun()
  return {
    ...fixture,
    request: {
      ...fixture.request,
      requester: { kind: "user" as const },
      directory: isolated,
      target: { kind: "branch" as const, base },
      background: true,
    },
    status: "running" as const,
    result: undefined,
  }
}

function ask() {
  return {
    id: "per_directory_fixture",
    sessionID: "ses_private_directory_anchor",
    permission: "connect_model",
    patterns: ["fixture/model"],
    always: [],
    metadata: {
      directoryReview: true,
      directory: isolated,
      runID: "cr_fixture",
      description: "Review this checkout with fixture/model, capped at $0.50.",
    },
  }
}

async function openDashboard(page: Page) {
  await page.getByRole("button", { name: "Agent Dashboard", exact: true }).click()
  const dashboard = page.getByRole("dialog", { name: "Agent Dashboard" })
  await expect(dashboard.getByRole("button", { name: /^Open Review the isolated parser:/ })).toBeVisible()
  return dashboard
}

test("default-off and older engines mount the real workspace card without connect calls", async ({ page }) => {
  const app = await setup(page, { capabilities: {} })
  await installNativeRecord(page)
  const calls: string[] = []
  await page.route(/\/experimental\/connect(?:\/|\?|$)/, (route) => {
    calls.push(route.request().url())
    return reply(route, [])
  })
  await app.open()
  const dashboard = await openDashboard(page)
  await expect(dashboard.locator('[data-component="directory-review"]')).toHaveCount(0)
  await expect(dashboard.getByRole("button", { name: "Review with VectorScope" })).toHaveCount(0)
  expect(calls).toEqual([])
})

test("the actual card reconciles early consent, sends one explicit once reply and renders only the owner result", async ({
  page,
}) => {
  let pending: ReturnType<typeof ask>[] = []
  const app = await setup(page, { capabilities: { connections: true }, permissions: () => pending })
  await installNativeRecord(page)
  const run = runningRun()
  let started = false
  let finished = false
  const requests: { path: string; directory: string | null; body: unknown }[] = []
  await page.route(/\/(?:experimental\/connect(?:\/.*)?|permission\/[^/]+\/reply)(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === "OPTIONS") return reply(route, [])
    requests.push({
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      body: route.request().postDataJSON(),
    })
    if (url.pathname === "/experimental/connect/review") {
      started = true
      pending = [ask()]
      await app.send("permission.asked", pending[0], isolated)
      return reply(route, { ...run, status: "queued" })
    }
    if (url.pathname.endsWith("/reply")) {
      pending = []
      finished = true
      return reply(route, true)
    }
    const owned = finished ? { ...run, status: "done", result: reviewRun().result } : run
    return reply(route, url.pathname.endsWith("/runs") ? (started ? [owned] : []) : owned)
  })
  await app.open()
  const dashboard = await openDashboard(page)
  const card = dashboard.locator('[data-component="directory-review"]')
  await card.getByRole("button", { name: "Review with VectorScope" }).click()
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible()
  expect(requests.filter((request) => request.path.endsWith("/reply"))).toEqual([])
  await card.getByRole("button", { name: "Allow once" }).click()
  await expect(card).toContainText("Incomplete review")
  await expect(card).toContainText(reviewRun().result!.summary)
  await app.send(
    "connect.run.updated",
    {
      sessionID: ask().sessionID,
      run: { ...run, status: "done", result: { ...reviewRun().result!, summary: "Event-only forged summary" } },
    },
    isolated,
  )
  await expect(card).not.toContainText("Event-only forged summary")
  expect(requests.filter((request) => request.path.endsWith("/reply")).map((request) => request.body)).toEqual([
    { reply: "once" },
  ])
  expect(requests.find((request) => request.path.endsWith("/review"))?.body).toEqual({
    target: { kind: "branch", base },
    background: true,
  })
  expect(requests.every((request) => request.directory === isolated)).toBe(true)
  await expect(dashboard.locator("button button")).toHaveCount(0)
  expect(app.capture.session.filter((request) => request.method === "POST")).toEqual([])
})

test("reload recovers pending consent; closing observation does not stop and Cancel review does", async ({ page }) => {
  let pending = [ask()]
  let cancelled = false
  const app = await setup(page, { capabilities: { connections: true }, permissions: () => pending })
  await installNativeRecord(page)
  const stops: string[] = []
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === "OPTIONS") return reply(route, [])
    if (url.pathname.endsWith("/cancel")) {
      stops.push(url.searchParams.get("directory") ?? "")
      cancelled = true
      pending = []
      return reply(route, true)
    }
    const run = runningRun()
    const owned = cancelled
      ? { ...run, status: "done", result: { ...reviewRun().result!, state: "cancelled", verdict: "not-reviewed" } }
      : run
    return reply(route, url.pathname.endsWith("/runs") ? [owned] : owned)
  })
  await app.open()
  let dashboard = await openDashboard(page)
  await expect(dashboard.getByRole("button", { name: "Allow once" })).toBeVisible()
  await dashboard.getByRole("button", { name: "Close Agent Dashboard" }).click()
  expect(stops).toEqual([])
  await page.reload()
  dashboard = await openDashboard(page)
  await expect(dashboard.getByRole("button", { name: "Reject", exact: true })).toBeVisible()
  await dashboard.getByRole("button", { name: "Cancel review", exact: true }).click()
  await expect(dashboard.locator('[data-component="directory-review"]')).toContainText("Review cancelled")
  expect(stops).toEqual([isolated])
})

test("guest owner reads hide the action; cross-directory permission metadata never creates approval controls", async ({
  page,
}) => {
  const wrong = { ...ask(), metadata: { ...ask().metadata, directory: `${isolated}/other` } }
  const app = await setup(page, { capabilities: { connections: true }, permissions: [wrong] })
  await installNativeRecord(page)
  let guest = true
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => {
    if (guest) return reply(route, { message: "Owner only" }, 403)
    return reply(route, new URL(route.request().url()).pathname.endsWith("/runs") ? [runningRun()] : runningRun())
  })
  await app.open()
  const dashboard = await openDashboard(page)
  await expect(dashboard.locator('[data-component="directory-review"]')).toHaveCount(0)
  guest = false
  await dashboard.getByRole("button", { name: "Close Agent Dashboard" }).click()
  const reopened = await openDashboard(page)
  await expect(reopened.locator('[data-component="directory-review"]')).toContainText("Review in progress")
  await expect(reopened.getByRole("button", { name: "Allow once" })).toHaveCount(0)
})
