import { expect, test, type Route } from "@playwright/test"
import { reviewRun } from "../../src/features/connect/test-fixture"
import { assistantMessage, child, directory, openTasks, rootID, setup, task, userMessage } from "../utils/multiagent"

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
  await page.route(/\/permission\/per_connected_write\/reply(?:\?|$)/, (route) => reply(route, true))
  await app.open()
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  const patch = dock.getByRole("region", { name: "Changes to apply" })
  await expect(patch).toBeVisible()
  await patch.focus()
  await expect(patch).toBeFocused()
  expect(await patch.textContent()).toBe(diff)
  await expect(patch.locator("script")).toHaveCount(0)
  await expect(dock.getByRole("button", { name: "Allow always", exact: true })).toHaveCount(0)
  const approval = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/permission/per_connected_write/reply",
  )
  await dock.getByRole("button", { name: "Allow once", exact: true }).click()
  expect((await approval).postDataJSON()).toEqual({ reply: "once", confirm: true })
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

test("Connected tools offers report mode but cannot newly select automatic repair", async ({ page }) => {
  const app = await setup(page, { capabilities: { connections: true }, globalConfig: {} })
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => reply(route, []))
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const tools = settings.locator('[data-component="connected-tools"]')
  const mode = tools.getByRole("combobox", { name: "After-run review", exact: true })
  await expect(mode).toHaveValue("off")
  // Playwright's disabled matcher follows the enclosing label to the select.
  await expect(mode.locator('option[value="repair"]')).toHaveJSProperty("disabled", true)
  await mode.selectOption("report")
  await tools.getByRole("button", { name: "Save review settings", exact: true }).click()
  await expect
    .poll(() => app.capture.config)
    .toEqual([{ connect: { review: { after_run: "report", before_commit: "offer", max_rounds: 1, max_cost_usd: 2 } } }])
})

test("Connected tools retains a saved repair setting when another review setting changes", async ({ page }) => {
  const app = await setup(page, {
    capabilities: { connections: true },
    globalConfig: {
      connect: { review: { after_run: "repair", before_commit: "offer", max_rounds: 1, max_cost_usd: 2 } },
    },
  })
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => reply(route, []))
  await app.open()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  const tools = settings.locator('[data-component="connected-tools"]')
  const mode = tools.getByRole("combobox", { name: "After-run review", exact: true })
  await expect(mode).toHaveValue("repair")
  await expect(mode.locator('option[value="repair"]')).toHaveJSProperty("disabled", true)
  await tools.getByRole("textbox", { name: "Review cap", exact: true }).fill("1.25")
  await tools.getByRole("button", { name: "Save review settings", exact: true }).click()
  await expect
    .poll(() => app.capture.config)
    .toEqual([
      { connect: { review: { after_run: "repair", before_commit: "offer", max_rounds: 1, max_cost_usd: 1.25 } } },
    ])
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

const vectorscopeMember = {
  id: "vectorscope",
  kind: "agent",
  title: "VectorScope",
  summary: "Review selected changes.",
  owner: "vectorscope",
  place: "local",
  sendsTo: "this-computer",
  state: "ready",
  reach: "connect",
  actions: [{ id: "review", title: "Review", effects: ["read"], background: true, result: "review" }],
}

/** A review of the root conversation still going, or the same run once it was cancelled. */
function rootRun(id: string, cancelled = false) {
  const fixture = reviewRun()
  const request = { ...fixture.request, id, directory, requester: { kind: "user", sessionID: rootID } }
  if (cancelled)
    return {
      ...fixture,
      id,
      request,
      result: { ...fixture.result!, state: "cancelled", verdict: undefined, summary: "The review was cancelled." },
      time: { created: 4, started: 5, ended: 6 },
    }
  return {
    ...fixture,
    id,
    request,
    status: "running",
    result: undefined,
    progress: { message: "Reviewing src/example.ts", at: 5 },
    time: { created: 4, started: 5 },
  }
}

test("the Tasks pane lists the conversation's connected runs, cancels a running one and never applies a fix", async ({
  page,
}) => {
  const fixture = reviewRun()
  const finished = {
    ...fixture,
    request: { ...fixture.request, directory, requester: { kind: "user", sessionID: rootID } },
  }
  const app = await setup(page, { capabilities: { connections: true } })
  let cancelled = false
  let mode: "owner" | "hold" | "guest" = "owner"
  let reads = 0
  // A held read waits for the answer it is released with.
  const held: ((answer: "owner" | "guest") => void)[] = []
  const cancels: (string | null)[] = []
  const writes: string[] = []
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") return reply(route, [])
    const url = new URL(request.url())
    if (url.pathname === "/experimental/connect/runs/cr_running/cancel" && request.method() === "POST") {
      cancels.push(url.searchParams.get("sessionID"))
      cancelled = true
      return reply(route, true)
    }
    if (request.method() === "POST") writes.push(url.pathname)
    if (url.pathname === "/experimental/connect") return reply(route, [vectorscopeMember])
    if (url.pathname !== "/experimental/connect/runs") return reply(route, [])
    if (url.searchParams.get("sessionID") !== rootID) return reply(route, [])
    reads++
    const answer = mode === "hold" ? await new Promise<"owner" | "guest">((resolve) => held.push(resolve)) : mode
    if (answer === "guest") return reply(route, { message: "This operation requires the server owner" }, 403)
    return reply(route, [rootRun("cr_running", cancelled), finished])
  })
  await app.open()
  const panel = await openTasks(page)
  const section = panel.locator('[data-component="connect-task-rows"]')
  const rows = section.getByRole("listitem")
  await expect(rows).toHaveCount(2)
  const running = rows.nth(0)
  await expect(running).toContainText("VectorScope · Review")
  await expect(running).toContainText("Running")
  await expect(running).toContainText("Reviewing src/example.ts")
  await expect(running).toContainText("Sends code to: This computer")
  await expect(running.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(1)
  const done = rows.nth(1)
  await expect(done).toContainText("Partial")
  await expect(done).toContainText("Incomplete review")
  await expect(done).toContainText("Code sent to: This computer")
  await expect(done).toContainText("Usage unavailable")
  await expect(done.getByRole("button")).toHaveCount(0)
  await expect(section.getByRole("button", { name: /fix/i })).toHaveCount(0)
  await expect(section).not.toContainText(fixture.result!.findings[0].body)

  // Reads follow events and reconnects only: nothing polls, and another conversation's events are ignored.
  await page.waitForTimeout(500)
  const settled = reads
  await page.waitForTimeout(1500)
  expect(reads).toBe(settled)
  await app.send("connect.run.updated", { sessionID: "ses_other_conversation", run: finished })
  await page.waitForTimeout(1000)
  expect(reads).toBe(settled)
  await app.send("connect.run.updated", { sessionID: rootID, run: finished })
  await expect.poll(() => reads).toBe(settled + 1)

  await running.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect.poll(() => cancels).toEqual([rootID])
  await expect(rows.nth(0)).toContainText("Cancelled")
  await expect(section.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)

  // An authority change hides the rows at once, while the fresh read is still held, and a read started before it
  // can never bring them back.
  mode = "hold"
  await app.send("connect.run.updated", { sessionID: rootID, run: finished })
  await expect.poll(() => held.length).toBe(1)
  await app.send("global.disposed", {}, "global")
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(2)
  await expect(section).toHaveCount(0)
  const [stale, ...fresh] = held.splice(0)
  mode = "guest"
  const refused = page.waitForResponse(
    (response) => response.status() === 403 && new URL(response.url()).pathname === "/experimental/connect/runs",
  )
  fresh.forEach((release) => release("guest"))
  await refused
  stale("owner")
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect(section).toHaveCount(0)

  // After a refusal the pane makes no further owner reads until authority changes.
  await page.waitForTimeout(500)
  const blocked = reads
  await app.send("connect.run.updated", { sessionID: rootID, run: finished })
  await app.send("connect.run.updated", { sessionID: rootID, run: finished })
  await page.waitForTimeout(1200)
  expect(reads).toBe(blocked)

  mode = "hold"
  await app.send("server.connected", {}, "global")
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(1)
  await expect(section).toHaveCount(0)
  mode = "owner"
  held.splice(0).forEach((release) => release("owner"))
  await expect(rows).toHaveCount(2)

  mode = "guest"
  await app.send("connect.run.updated", { sessionID: rootID, run: finished })
  await expect(section).toHaveCount(0)
  expect(writes).toEqual([])
  expect(
    app.capture.session.filter(
      (request) => request.method === "POST" && /\/session\/[^/]+\/(?:message|prompt_async)(?:\?|$)/.test(request.path),
    ),
  ).toEqual([])
  expect(app.capture.config).toEqual([])
})

test("connected runs scroll in their own box below a long task list, so the last Cancel stays reachable", async ({
  page,
}) => {
  const ids = Array.from({ length: 14 }, (_, index) => `ses_bulk_${index}`)
  const tasks = ids.map((id, index) => task({ id, title: `Bulk task ${index}` }))
  const app = await setup(page, {
    capabilities: { connections: true, backgroundSubagents: true },
    sessions: ids.map((id, index) => child(id, `Bulk task ${index} (@general subagent)`)),
    status: Object.fromEntries([rootID, ...ids].map((id) => [id, { type: "busy" }])),
    taskList: () => ({ tasks, truncated: false }),
  })
  const runs = Array.from({ length: 10 }, (_, index) => rootRun(`cr_bulk_${index}`))
  const cancels: string[] = []
  await page.route(/\/experimental\/connect(?:\/.*)?(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === "POST" && url.pathname.endsWith("/cancel")) {
      cancels.push(url.pathname)
      return reply(route, true)
    }
    if (url.pathname === "/experimental/connect") return reply(route, [vectorscopeMember])
    return reply(route, url.pathname === "/experimental/connect/runs" ? runs : [])
  })
  await app.open()
  const panel = await openTasks(page)
  await expect(panel.locator("article.vector-bg-tasks-card")).not.toHaveCount(0)
  const section = panel.locator('[data-component="connect-task-rows"]')
  await expect(section.getByRole("listitem")).toHaveCount(10)
  const last = section.getByRole("listitem").nth(9).getByRole("button", { name: "Cancel", exact: true })
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  // The section scrolled itself; the pane, its header and the task list stayed where they were.
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(0)
  expect(await section.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const pane = (await panel.boundingBox())!
  const box = (await section.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1)
  expect((await panel.locator(".vector-bg-tasks-list").boundingBox())!.height).toBeGreaterThan(0)
  await last.click()
  await expect.poll(() => cancels).toEqual(["/experimental/connect/runs/cr_bulk_9/cancel"])
})
