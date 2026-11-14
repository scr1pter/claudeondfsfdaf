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
  await expect(card).toContainText("Usage unavailable")
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
  expect(requests.find((request) => request.path.endsWith("/review"))?.body).toMatchObject({
    requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    target: { kind: "branch", base },
    background: true,
  })
  expect(requests.every((request) => request.directory === isolated)).toBe(true)
  await expect(dashboard.locator("button button")).toHaveCount(0)
  expect(app.capture.session.filter((request) => request.method === "POST")).toEqual([])
})

test("same-SDK authority changes remove private directory findings before fresh proof and reject late old responses", async ({
  page,
}) => {
  const app = await setup(page, { capabilities: { connections: true } })
  await installNativeRecord(page)
  const run = {
    ...runningRun(),
    status: "done",
    result: { ...reviewRun().result!, summary: "Private directory receipt", cost: { kind: "priced", usd: 0.17 } },
  }
  let mode: "owner" | "old" | "guest" | "fresh" = "owner"
  let releaseOld: (() => void) | undefined
  let releaseFresh: (() => void) | undefined
  const posts: string[] = []
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return reply(route, [])
    if (route.request().method() === "POST") posts.push(route.request().url())
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/runs")) return reply(route, [run])
    const selected = mode
    if (selected === "old")
      await new Promise<void>((resolve) => {
        releaseOld = resolve
      })
    if (selected === "fresh")
      await new Promise<void>((resolve) => {
        releaseFresh = resolve
      })
    return selected === "guest" ? reply(route, { message: "Owner only" }, 403) : reply(route, run)
  })
  await app.open()
  const dashboard = await openDashboard(page)
  const card = dashboard.locator('[data-component="directory-review"]')
  await expect(card).toContainText("Private directory receipt")
  await expect(card).toContainText("$0.17")
  mode = "old"
  const old = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/runs/cr_fixture"))
  await card.getByRole("button", { name: "Refresh review", exact: true }).click()
  await old
  mode = "guest"
  const refused = page.waitForResponse(
    (response) => response.status() === 403 && new URL(response.url()).pathname.endsWith("/runs/cr_fixture"),
  )
  await app.send("global.disposed", {}, "global")
  await refused
  await expect(dashboard.getByText("Private directory receipt", { exact: true })).toHaveCount(0)
  releaseOld?.()
  await expect(card).toHaveCount(0)
  mode = "fresh"
  const fresh = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/runs/cr_fixture"))
  await app.send("server.connected", {}, "global")
  await fresh
  await expect(dashboard.getByText("Private directory receipt", { exact: true })).toHaveCount(0)
  releaseFresh?.()
  await expect(card).toContainText("Private directory receipt")
  expect(posts).toEqual([])
})

test("a lost review response persists one opaque unpaid request and only explicit retry sends that same body after reload", async ({
  page,
}) => {
  const app = await setup(page, { capabilities: { connections: true } })
  await installNativeRecord(page)
  const bodies: unknown[] = []
  let admitted = false
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return reply(route, [])
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/review")) {
      bodies.push(route.request().postDataJSON())
      if (bodies.length === 1) {
        await app.send("connect.run.updated", { sessionID: ask().sessionID, run: runningRun() }, isolated)
        return route.abort("failed")
      }
      admitted = true
      return reply(route, runningRun())
    }
    return reply(route, path.endsWith("/runs") ? (admitted ? [runningRun()] : []) : runningRun())
  })
  await app.open()
  let dashboard = await openDashboard(page)
  await dashboard.getByRole("button", { name: "Review with VectorScope", exact: true }).click()
  await expect(dashboard.getByRole("button", { name: "Retry review start", exact: true })).toBeEnabled()
  await expect(dashboard.getByRole("button", { name: "Review with VectorScope", exact: true })).toBeDisabled()
  const saved = await page.evaluate(() =>
    Object.entries(sessionStorage).filter(([key]) => key.startsWith("connect.directory-admission.")),
  )
  expect(saved).toHaveLength(1)
  expect(saved[0][0]).toMatch(/^connect\.directory-admission\.[0-9a-f]{64}$/)
  expect(saved[0][1]).not.toContain("http")
  expect(saved[0][1]).not.toContain(reviewRun().result!.findings[0].body)
  await page.reload()
  dashboard = await openDashboard(page)
  await expect(dashboard.getByRole("button", { name: "Review with VectorScope", exact: true })).toBeDisabled()
  expect(bodies).toHaveLength(1)
  await dashboard.getByRole("button", { name: "Retry review start", exact: true }).click()
  await expect(dashboard.locator('[data-component="directory-review"]')).toContainText("Review in progress")
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  await expect(dashboard.getByRole("button", { name: "Retry review start", exact: true })).toHaveCount(0)
})

for (const mutation of ["remove", "replace"] as const)
  test(`a lost review never sends another POST when its original marker is ${mutation}d`, async ({ page }) => {
    const app = await setup(page, { capabilities: { connections: true } })
    await installNativeRecord(page)
    const bodies: unknown[] = []
    await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return reply(route, [])
      const path = new URL(route.request().url()).pathname
      if (path.endsWith("/review")) {
        bodies.push(route.request().postDataJSON())
        return route.abort("failed")
      }
      return reply(route, path.endsWith("/runs") ? [] : runningRun())
    })
    await app.open()
    const dashboard = await openDashboard(page)
    await dashboard.getByRole("button", { name: "Review with VectorScope", exact: true }).click()
    const retry = dashboard.getByRole("button", { name: "Retry review start", exact: true })
    await expect(retry).toBeEnabled()
    expect(bodies).toHaveLength(1)
    await page.evaluate((mutation) => {
      const saved = Object.entries(sessionStorage).find(([key]) => key.startsWith("connect.directory-admission."))
      if (!saved) throw new Error("The first admission did not save its marker")
      if (mutation === "remove") sessionStorage.removeItem(saved[0])
      else {
        const request = JSON.parse(saved[1])
        sessionStorage.setItem(saved[0], JSON.stringify({ ...request, requestKey: crypto.randomUUID() }))
      }
    }, mutation)
    await retry.click()
    await expect(dashboard).toContainText("This review start cannot be tracked safely")
    await expect(dashboard.getByRole("button", { name: "Review with VectorScope", exact: true })).toBeDisabled()
    expect(bodies).toHaveLength(1)
  })

test("completed Codium directory review shows canonical plan usage without manufacturing a dollar total", async ({
  page,
}) => {
  const app = await setup(page, { capabilities: { connections: true } })
  await installNativeRecord(page)
  const run = {
    ...runningRun(),
    status: "done",
    result: { ...reviewRun().result!, sendsTo: "vector-codium", cost: { kind: "plan" } },
  }
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) =>
    reply(route, new URL(route.request().url()).pathname.endsWith("/runs") ? [run] : run),
  )
  await app.open()
  const dashboard = await openDashboard(page)
  const card = dashboard.locator('[data-component="directory-review"]')
  await expect(card).toContainText("Plan usage")
  await expect(card).not.toContainText("$0.00")
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
