import { expect, test, type Page, type Route } from "@playwright/test"
import { createHash } from "node:crypto"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { directory, port, rootID, rootTitle, session, sessionHref, setup } from "../utils/multiagent"

const otherID = "ses_local_scope_other_main"
const runID = SessionID.make("ses_local_scope_owned_run")
const head = "a".repeat(40)
const target: ReviewRun.Target = { kind: "working-tree", head }
const request: ReviewRun.Start = { requestID: "request_full_app_local_1", target }
const info = (parentID: string, input = request, status: ReviewRun.Status = "running"): ReviewRun.Info => ({
  parentID: SessionID.make(parentID),
  runID,
  request: input,
  status,
  startedAt: 1,
  canStop: status === "running",
})

function retained(): ReviewRun.Info {
  const outcome: ReviewOutcome = {
    report: { summary: "Private main-parent review", risk: "low", files: [], findings: [] },
    selection: {
      inline: [],
      outsideDiff: [],
      elsewhere: [],
      nits: [],
      overflow: [],
      stillOpen: [],
      fixed: [],
      dismissed: [],
      reappeared: [],
      raised: [],
      dropped: [],
      risk: "low",
    },
    skipped: [],
    durationMs: 10,
    base: "b".repeat(40),
    head,
    mode: "full",
    unreviewed: [],
    specialists: [{ name: "review", status: "ok", steps: 1 }],
    sessions: ["ses_local_review_child"],
    stats: { files: 1, additions: 1, deletions: 1 },
    notes: [],
  }
  const json = JSON.stringify({
    exitCode: 0,
    target: { kind: "uncommitted", label: "local changes", baseRef: "HEAD", mergeBase: outcome.base, head },
    outcome,
    verdict: reviewVerdict({ kind: "outcome", outcome }),
  })
  return {
    ...info(rootID, request, "completed"),
    artifact: {
      version: 1,
      json,
      bytes: Buffer.byteLength(json),
      sha256: createHash("sha256").update(json).digest("hex"),
    },
  }
}

async function fullApp(
  page: Page,
  options: { enabled?: boolean; supported?: boolean; retained?: boolean; repositoryFlag?: boolean } = {},
) {
  const app = await setup(page, {
    sessions: [session(otherID, "Another main conversation")],
    capabilities: { vectorscopeRuns: options.supported !== false },
    globalConfig: {
      experimental: { vectorscope: options.enabled !== false },
      agent: { vectorscope: { disable: false } },
    },
  })
  // No GitHub or Vector account is signed in. Only the existing desktop PR
  // status seam is present so the real panel shows its ordinary local entry.
  await page.addInitScript(() =>
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        pullRequests: {
          status: async () => ({ authenticated: false, configured: false, detail: "No GitHub connection" }),
        },
      },
    }),
  )
  const state = {
    mode: "owner" as "owner" | "guest" | "foreign" | "missing",
    current: options.retained ? retained() : (undefined as ReviewRun.Info | undefined),
    calls: [] as { method: string; parentID: string; directory: string | null; body?: unknown }[],
    repositoryReads: 0,
    sessionCreates: 0,
    resultEntered: undefined as (() => void) | undefined,
    resultWait: undefined as Promise<void> | undefined,
  }
  page.on("request", (value) => {
    const url = new URL(value.url())
    if (url.port === port && url.pathname === "/session" && value.method() === "POST") state.sessionCreates++
  })
  const reply = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })
  if (options.repositoryFlag)
    await page.route(
      (url) => url.port === port && url.pathname === "/config",
      (route) => {
        state.repositoryReads++
        return reply(route, { experimental: { vectorscope: true } })
      },
    )
  await page.route(
    (url) => url.port === port && url.pathname === `/session/${rootID}`,
    async (route) => {
      if (state.mode === "missing") return reply(route, { error: "Not found" }, 404)
      if (state.mode === "foreign")
        return reply(
          route,
          session(rootID, rootTitle, { directory: "C:/Vector/Foreign", projectID: "foreign-project" }),
        )
      return route.fallback()
    },
  )
  await page.route(
    (url) => url.port === port && /^\/experimental\/session\/[^/]+\/review(?:\/|$)/.test(url.pathname),
    async (route) => {
      const value = route.request(),
        url = new URL(value.url()),
        path = url.pathname
      const match = /^\/experimental\/session\/([^/]+)\/review(.*)$/.exec(path)
      if (!match) return reply(route, { error: "No route" }, 404)
      const parentID = match[1]!,
        suffix = match[2]!
      state.calls.push({
        method: value.method(),
        parentID,
        directory: url.searchParams.get("directory"),
        ...(value.method() === "POST" ? { body: value.postDataJSON() } : {}),
      })
      if (state.mode !== "owner")
        return reply(route, { error: "Owner or placement refused" }, state.mode === "guest" ? 403 : 400)
      if (suffix === "/target") return reply(route, target)
      if (!suffix && value.method() === "GET") {
        const current = state.current?.parentID === parentID ? state.current : undefined
        const { artifact, ...summary } = current ?? {}
        return reply(route, { runs: current ? [{ ...summary, hasResult: !!artifact }] : [] })
      }
      if (!suffix && value.method() === "POST") {
        const input: ReviewRun.Start = value.postDataJSON()
        state.current = info(parentID, input)
        return reply(route, state.current)
      }
      if (suffix === `/${runID}/stop` && value.method() === "POST") {
        state.current = info(parentID, state.current?.request, "cancelled")
        return reply(route, state.current)
      }
      if (suffix === `/${runID}` && value.method() === "GET" && state.current?.parentID === parentID) {
        const captured = state.current
        state.resultEntered?.()
        if (state.resultWait) await state.resultWait
        return reply(route, captured).catch(() => undefined)
      }
      return reply(route, { error: "Not found" }, 404)
    },
  )
  await app.open()
  const open = async () => {
    await page.locator('[data-tour="nav-pull-requests"]').click()
    const dialog = page.getByRole("dialog", { name: "Vectorscope", exact: true })
    await expect(dialog).toBeVisible()
    return dialog
  }
  return { app, state, open }
}

const local = (page: Page) => page.getByRole("region", { name: "Local VectorScope reviews", exact: true })
const mutationCount = (calls: { method: string }[]) => calls.filter((call) => call.method === "POST").length

test("the full App routes its actual local entry through owner-global policy and an existing main parent without GitHub login", async ({
  page,
}) => {
  const f = await fullApp(page)
  const dialog = await f.open()
  await dialog.getByRole("button", { name: "Review my changes", exact: true }).click()
  await expect(local(page)).toBeVisible()
  const start = local(page).getByRole("button", { name: "Start local review", exact: true })
  await expect(start).toBeEnabled()
  expect(mutationCount(f.state.calls)).toBe(0)
  await start.click()
  await expect(local(page).getByRole("heading", { name: "Review running", exact: true })).toBeVisible()
  const starts = f.state.calls.filter((call) => call.method === "POST")
  expect(starts).toEqual([
    { method: "POST", parentID: rootID, directory, body: { requestID: expect.any(String), target } },
  ])
  expect(f.app.capture.session).toEqual([])
  expect(f.state.sessionCreates).toBe(0)
  await local(page).getByRole("button", { name: "Stop local review", exact: true }).click()
  await expect(local(page).getByRole("heading", { name: "Review cancelled", exact: true })).toBeVisible()
})

test("the full App ignores a repository flag when the owner global opt-in is off", async ({ page }) => {
  const f = await fullApp(page, { enabled: false, repositoryFlag: true })
  const dialog = await f.open()
  await dialog.getByRole("button", { name: "Local reviews", exact: true }).click()
  await expect(local(page).getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
  await expect(local(page)).toContainText("New local reviews are off")
  await expect.poll(() => f.state.repositoryReads).toBeGreaterThan(0)
  expect(mutationCount(f.state.calls)).toBe(0)
})

test("an older engine never exposes or calls the new local review composition", async ({ page }) => {
  const f = await fullApp(page, { supported: false })
  const dialog = await f.open()
  await expect(dialog.getByRole("button", { name: "Local reviews", exact: true })).toHaveCount(0)
  expect(f.state.calls).toEqual([])
})

for (const mode of ["guest", "foreign", "missing"] as const)
  test(`the full App refuses a ${mode} authority despite a previously cached main parent`, async ({ page }) => {
    const f = await fullApp(page)
    f.state.mode = mode
    const dialog = await f.open()
    await dialog.getByRole("button", { name: "Local reviews", exact: true }).click()
    await expect(local(page).getByRole("alert")).toBeVisible()
    await expect(local(page).getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
    expect(mutationCount(f.state.calls)).toBe(0)
    expect(f.app.capture.session).toEqual([])
    expect(f.state.sessionCreates).toBe(0)
  })

test("the full App retires a delayed private result on same-checkout main-parent navigation without retargeting a POST", async ({
  page,
}) => {
  const f = await fullApp(page, { retained: true })
  const entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>()
  f.state.resultEntered = () => entered.resolve()
  f.state.resultWait = released.promise
  const dialog = await f.open()
  await dialog.getByRole("button", { name: "Local reviews", exact: true }).click()
  await local(page).getByRole("button", { name: "Open review", exact: true }).click()
  await entered.promise
  await page.evaluate((path) => {
    history.pushState(null, "", path)
    dispatchEvent(new PopStateEvent("popstate"))
  }, sessionHref(otherID))
  await expect.poll(() => f.state.calls.some((call) => call.parentID === otherID && call.method === "GET")).toBe(true)
  released.resolve()
  await expect(local(page).getByText("Private main-parent review", { exact: true })).toHaveCount(0)
  await expect(local(page).getByRole("button", { name: "Start local review", exact: true })).toBeEnabled()
  expect(mutationCount(f.state.calls)).toBe(0)
  expect(f.app.capture.session).toEqual([])
})

test("the full App clears a retained result when the actual engine reconnect loses owner access", async ({ page }) => {
  const f = await fullApp(page, { retained: true })
  const dialog = await f.open()
  await dialog.getByRole("button", { name: "Local reviews", exact: true }).click()
  await local(page).getByRole("button", { name: "Open review", exact: true }).click()
  await expect(local(page).getByText("Private main-parent review", { exact: true })).toBeVisible()
  f.state.mode = "guest"
  await f.app.send("server.connected", {})
  await expect(local(page).getByText("Private main-parent review", { exact: true })).toHaveCount(0)
  await expect(local(page).getByRole("alert")).toContainText("Owner access")
  await expect(local(page).getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
  expect(mutationCount(f.state.calls)).toBe(0)
})
