import { expect, test, type Route } from "@playwright/test"
import { reviewRun } from "../../src/features/connect/test-fixture"
import { assistantMessage, directory, rootID, setup, userMessage } from "../utils/multiagent"

function reply(route: Route, body: unknown, status = 200) {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "*",
  }
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers })
  return route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) })
}

test("connected settings keep an unsaved draft and focus when a run refreshes", async ({ page }) => {
  const app = await setup(page, { capabilities: { connections: true }, globalConfig: {} })
  const scopes: (string | null)[] = []
  await page.route(/\/experimental\/connect(?:\/runs)?(?:\?|$)/, (route) => {
    if (route.request().method() === "GET") scopes.push(new URL(route.request().url()).searchParams.get("directory"))
    return reply(route, [])
  })
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const tools = settings.locator('[data-component="connected-tools"]')
  const cap = tools.getByRole("textbox", { name: "Review cap", exact: true })
  await expect(cap).toBeVisible()
  await cap.fill("1.25")
  const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === "/experimental/connect/runs")
  await app.send("connect.run.updated", { sessionID: rootID, run: reviewRun() })
  await refresh
  await expect(cap).toHaveValue("1.25")
  await expect(cap).toBeFocused()
  expect(scopes.length).toBeGreaterThan(0)
  expect(scopes.every((selected) => selected === directory)).toBe(true)
  expect(app.capture.config).toEqual([])
})

test("Connected tools fixes an existing owned run through an identifier-only composer handoff", async ({ page }) => {
  const fixture = reviewRun()
  const run = { ...fixture, request: { ...fixture.request, directory, requester: { kind: "user", sessionID: rootID } } }
  const app = await setup(page, {
    capabilities: { connections: true },
    globalConfig: {},
    messages: { [rootID]: [userMessage(rootID, "msg_connected_action", "Review these changes.")] },
  })
  let ownerReads = 0
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (route.request().method() === "GET" && pathname.endsWith("/runs/cr_fixture")) ownerReads++
    return reply(route, pathname.endsWith("/runs/cr_fixture") ? run : pathname.endsWith("/runs") ? [run] : [])
  })
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  await settings.locator('[data-component="connected-tools"]').getByRole("button", { name: "Fix", exact: true }).click()
  await expect
    .poll(
      () =>
        app.capture.session.filter(
          (request) =>
            request.method === "POST" && /\/session\/[^/]+\/(?:message|prompt_async)(?:\?|$)/.test(request.path),
        ).length,
    )
    .toBe(1)
  expect(ownerReads).toBe(1)
  const body = JSON.stringify(
    app.capture.session.find(
      (request) => request.method === "POST" && /\/session\/[^/]+\/(?:message|prompt_async)(?:\?|$)/.test(request.path),
    )!.body,
  )
  expect(body).toContain(run.id)
  expect(body).toContain(run.result!.findings[0]!.id)
  expect(body).not.toContain(run.result!.findings[0]!.body)
  expect(app.capture.config).toEqual([])
})

test("a background findings card reloads the owner result instead of displaying the event payload", async ({
  page,
}) => {
  const fixture = reviewRun()
  const finished = {
    ...fixture,
    request: { ...fixture.request, directory, requester: { kind: "user" as const, sessionID: rootID } },
  }
  let current: typeof finished = { ...finished, status: "running", result: undefined }
  const pending = current
  const app = await setup(page, {
    capabilities: { connections: true },
    messages: {
      [rootID]: [
        userMessage(rootID, "msg_connect_owner", "Review these changes."),
        assistantMessage(rootID, "msg_connect_call", "msg_connect_owner", [
          {
            id: "prt_connect_call",
            type: "tool",
            tool: "connect",
            callID: "call_connect_fixture",
            state: {
              status: "completed",
              input: { action: "review" },
              output: "Review in progress",
              title: "VectorScope review",
              metadata: { connect: pending },
              time: { start: 1, end: 2 },
            },
          },
        ]),
      ],
    },
  })
  await page.route(/\/experimental\/connect\/runs\/cr_fixture(?:\?|$)/, (route) => reply(route, current))
  const first = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/experimental/connect/runs/cr_fixture",
  )
  await app.open()
  await first
  const card = page.locator('[data-component="connect-findings-card"]')
  await expect(card).toHaveCount(0)
  current = finished
  await app.send("connect.run.updated", {
    sessionID: rootID,
    run: { ...finished, result: { ...finished.result!, summary: "Forged event-only summary" } },
  })
  await expect(card).toBeVisible()
  await expect(card).toContainText("Incomplete review")
  await expect(card).toContainText(finished.result!.summary)
  await expect(card).not.toContainText("Forged event-only summary")
  await expect(card.getByRole("button", { name: "Fix", exact: true })).toBeVisible()
})

test("a refused owner result leaves the plain tool row without findings actions", async ({ page }) => {
  const fixture = reviewRun()
  const run = { ...fixture, request: { ...fixture.request, requester: { kind: "user", sessionID: rootID } } }
  const app = await setup(page, {
    capabilities: { connections: true },
    messages: {
      [rootID]: [
        userMessage(rootID, "msg_connect_guest", "Review these changes."),
        assistantMessage(rootID, "msg_connect_guest_call", "msg_connect_guest", [
          {
            id: "prt_connect_guest",
            type: "tool",
            tool: "connect",
            callID: "call_connect_guest",
            state: {
              status: "completed",
              input: { action: "review" },
              output: "Review completed",
              title: "VectorScope review",
              metadata: { connect: run },
              time: { start: 1, end: 2 },
            },
          },
        ]),
      ],
    },
  })
  await page.route(/\/experimental\/connect\/runs\/cr_fixture(?:\?|$)/, (route) =>
    reply(route, { code: "forbidden", message: "Owner only" }, 403),
  )
  const refused = page.waitForResponse((response) => response.status() === 403)
  await app.open()
  await refused
  await expect(page.locator('[data-component="connect-findings-card"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Fix in a worktree", exact: true })).toHaveCount(0)
})
