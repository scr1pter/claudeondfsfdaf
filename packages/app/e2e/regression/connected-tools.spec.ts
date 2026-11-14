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

test("connected write approval shows the full patch as text before an explicit once-only decision", async ({
  page,
}) => {
  const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+<script>literal patch text</script>\n"
  const app = await setup(page, {
    capabilities: { connections: true },
    status: { [rootID]: { type: "busy" } },
    permissions: [
      {
        id: "per_connected_write",
        sessionID: rootID,
        permission: "connect_write",
        patterns: ["src/a.ts"],
        always: [],
        metadata: { runID: "cr_fixture", description: "Merge the reviewed fix.", diff },
      },
    ],
  })
  await app.open()
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  const patch = dock.getByRole("region", { name: "Changes to apply" })
  await expect(patch).toBeVisible()
  await patch.focus()
  await expect(patch).toBeFocused()
  expect(await patch.textContent()).toBe(diff)
  await expect(patch.locator("script")).toHaveCount(0)
  await expect(dock.getByRole("button", { name: "Allow always", exact: true })).toHaveCount(0)
  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/session/${rootID}/permissions/per_connected_write`,
  )
  await dock.getByRole("button", { name: "Allow once", exact: true }).click()
  expect((await reply).postDataJSON()).toEqual({ response: "once" })
})

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

test("root authority changes clear Connected tools and findings cards before fresh owner proof and ignore old responses", async ({
  page,
}) => {
  const fixture = reviewRun()
  const run = {
    ...fixture,
    request: { ...fixture.request, directory, requester: { kind: "user", sessionID: rootID } },
    result: { ...fixture.result!, summary: "Private owner review evidence" },
  }
  const app = await setup(page, {
    capabilities: { connections: true },
    globalConfig: {},
    messages: {
      [rootID]: [
        userMessage(rootID, "msg_owner_retirement", "Review changes."),
        assistantMessage(rootID, "msg_owner_retirement_call", "msg_owner_retirement", [
          {
            id: "prt_owner_retirement",
            type: "tool",
            tool: "connect",
            callID: "call_owner_retirement",
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
  let mode: "owner" | "old" | "guest" | "fresh" = "owner"
  const oldReleases: (() => void)[] = []
  const freshReleases: (() => void)[] = []
  const posts: string[] = []
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return reply(route, [])
    if (route.request().method() === "POST") posts.push(route.request().url())
    const path = new URL(route.request().url()).pathname
    const selected = mode
    if (selected === "old") await new Promise<void>((resolve) => oldReleases.push(resolve))
    if (selected === "fresh") await new Promise<void>((resolve) => freshReleases.push(resolve))
    if (selected === "guest") return reply(route, { message: "Owner only" }, 403)
    return reply(route, path.endsWith("/runs") ? [run] : path.endsWith("/runs/cr_fixture") ? run : [])
  })
  await app.open()
  const card = page.locator('[data-component="connect-findings-card"]')
  await expect(card).toContainText("Private owner review evidence")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const tools = settings.locator('[data-component="connected-tools"]')
  await expect(tools).toContainText("Private owner review evidence")
  mode = "old"
  await app.send("connect.run.updated", { sessionID: rootID, run })
  await expect.poll(() => oldReleases.length).toBeGreaterThanOrEqual(2)
  mode = "guest"
  const refused = page.waitForResponse(
    (response) => response.status() === 403 && new URL(response.url()).pathname.startsWith("/experimental/connect"),
  )
  await app.send("global.disposed", {}, "global")
  await refused
  await expect(page.getByText("Private owner review evidence", { exact: true })).toHaveCount(0)
  oldReleases.forEach((release) => release())
  await expect(card).toHaveCount(0)
  await expect(tools.getByRole("button", { name: "Fix", exact: true })).toHaveCount(0)
  mode = "fresh"
  await app.send("server.connected", {}, "global")
  await expect.poll(() => freshReleases.length).toBeGreaterThanOrEqual(2)
  await expect(page.getByText("Private owner review evidence", { exact: true })).toHaveCount(0)
  freshReleases.forEach((release) => release())
  await expect(tools).toContainText("Private owner review evidence")
  await expect(card).toContainText("Private owner review evidence")
  expect(posts).toEqual([])
})

for (const label of ["Fix", "Fix in a worktree"]) {
  test(`closing Connected tools aborts a delayed ${label} read without a late prompt`, async ({ page }) => {
    const fixture = reviewRun()
    const run = {
      ...fixture,
      request: { ...fixture.request, directory, requester: { kind: "user", sessionID: rootID } },
    }
    const app = await setup(page, {
      capabilities: { connections: true },
      globalConfig: {},
      messages: { [rootID]: [userMessage(rootID, "msg_disposed_tools", "Review changes.")] },
    })
    let release: () => void = () => {}
    let notify: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const effects: string[] = []
    await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === "POST") effects.push(path)
      if (route.request().method() === "GET" && path.endsWith("/runs/cr_fixture")) {
        notify()
        await gate
      }
      return reply(route, path.endsWith("/runs/cr_fixture") ? run : path.endsWith("/runs") ? [run] : [])
    })
    await app.open()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.locator(".settings-v2-workspace")
    await settings.getByRole("tab", { name: "Agents", exact: true }).click()
    const tools = settings.locator('[data-component="connected-tools"]')
    await tools.getByRole("button", { name: label, exact: true }).click()
    await entered
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "GET" && new URL(request.url()).pathname.endsWith("/experimental/connect/runs/cr_fixture"),
    })
    await page.keyboard.press("Escape")
    await expect(tools).toHaveCount(0)
    await aborted
    release()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(effects).toEqual([])
    expect(
      app.capture.session.filter(
        (request) => request.method === "POST" && /\/(?:message|prompt_async)(?:\?|$)/.test(request.path),
      ),
    ).toEqual([])
    await page.unroute(/\/experimental\/connect(?:\/.*)?(?:\?|$)/)
  })
}

for (const label of ["Fix", "Fix in a worktree", "Dismiss"]) {
  test(`removing a findings card aborts a delayed ${label} read without a late write`, async ({ page }) => {
    const fixture = reviewRun()
    const run = {
      ...fixture,
      request: { ...fixture.request, directory, requester: { kind: "user", sessionID: rootID } },
    }
    const partID = "prt_disposed_card"
    const messageID = "msg_disposed_card"
    const app = await setup(page, {
      capabilities: { connections: true },
      messages: {
        [rootID]: [
          userMessage(rootID, "msg_disposed_card_owner", "Review changes."),
          assistantMessage(rootID, messageID, "msg_disposed_card_owner", [
            {
              id: partID,
              type: "tool",
              tool: "connect",
              callID: "call_disposed_card",
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
    let hold = false
    let release: () => void = () => {}
    let notify: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      notify = resolve
    })
    const effects: string[] = []
    await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === "POST") effects.push(path)
      if (hold && route.request().method() === "GET" && path.endsWith("/runs/cr_fixture")) {
        notify()
        await gate
      }
      return reply(route, run)
    })
    await app.open()
    const card = page.locator('[data-component="connect-findings-card"]')
    await expect(card).toBeVisible()
    hold = true
    await card.getByRole("button", { name: label, exact: true }).click()
    await entered
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "GET" && new URL(request.url()).pathname.endsWith("/experimental/connect/runs/cr_fixture"),
    })
    await app.send("message.part.removed", { sessionID: rootID, messageID, partID })
    await expect(card).toHaveCount(0)
    await aborted
    release()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(effects).toEqual([])
    expect(
      app.capture.session.filter(
        (request) => request.method === "POST" && /\/(?:message|prompt_async)(?:\?|$)/.test(request.path),
      ),
    ).toEqual([])
    await page.unroute(/\/experimental\/connect(?:\/.*)?(?:\?|$)/)
  })
}

test("a pending connected-review save confirmation cannot apply after same-SDK authority retirement", async ({
  page,
}) => {
  const app = await setup(page, {
    capabilities: { connections: true },
    globalConfig: {},
    status: { [rootID]: { type: "busy" } },
  })
  let fresh = false
  let reads = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
    if (fresh && route.request().method() === "GET") {
      reads++
      await gate
    }
    return reply(route, [])
  })
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const tools = settings.locator('[data-component="connected-tools"]')
  await tools.getByRole("textbox", { name: "Review cap", exact: true }).fill("1.25")
  await tools.getByRole("button", { name: "Save review settings", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: "Save connected review settings?" })
  await expect(confirm).toBeVisible()
  fresh = true
  await app.send("global.disposed", {}, "global")
  await expect.poll(() => reads).toBeGreaterThan(0)
  await expect(tools.getByRole("button", { name: "Save review settings", exact: true })).toHaveCount(0)
  await confirm.getByRole("button", { name: "Save anyway", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  expect(app.capture.config).toEqual([])
  release()
})

test("closing Connected tools during the save-confirmation owner read cannot save after that read completes", async ({
  page,
}) => {
  const app = await setup(page, {
    capabilities: { connections: true, backgroundShells: true },
    globalConfig: {},
    status: { [rootID]: { type: "idle" } },
  })
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => reply(route, []))
  let hold = false
  let release: () => void = () => {}
  let notify: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    notify = resolve
  })
  await page.route(/\/experimental\/session\/[^/]+\/tasks(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    if (
      !hold ||
      route.request().method() !== "GET" ||
      url.searchParams.get("shells") !== "true" ||
      url.searchParams.get("limit") !== "1"
    )
      return route.fallback()
    notify()
    await gate
    return reply(route, { tasks: [], shells: [] })
  })
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const tools = settings.locator('[data-component="connected-tools"]')
  await tools.getByRole("textbox", { name: "Review cap", exact: true }).fill("1.25")
  hold = true
  await tools.getByRole("button", { name: "Save review settings", exact: true }).click()
  await entered
  await page.keyboard.press("Escape")
  await expect(tools).toHaveCount(0)
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(`/experimental/session/${rootID}/tasks`) &&
      new URL(response.url()).searchParams.get("shells") === "true",
  )
  release()
  await (await response).finished()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  expect(app.capture.config).toEqual([])
})
