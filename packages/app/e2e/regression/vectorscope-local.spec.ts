import { expect, test, type Page } from "@playwright/test"
import { createHash } from "node:crypto"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { reviewVerdict } from "@vectordevai/core/review/verdict"

const parentID = SessionID.make("ses_local_app_parent")
const runID = SessionID.make("ses_local_app_run")
const head = "a".repeat(40)
const base = "b".repeat(40)
const target: ReviewRun.Target = { kind: "working-tree", head }
const request: ReviewRun.Start = { requestID: "request_previous_local", target }
const run = (input = request, status: ReviewRun.Status = "running"): ReviewRun.Info => ({
  parentID,
  runID,
  request: input,
  status,
  startedAt: 1,
  canStop: status === "running",
})

async function completed(input = request, variant?: "overflow" | "still-open" | "partial"): Promise<ReviewRun.Info> {
  const outcome: ReviewOutcome = {
    report: { summary: "Exact retained pipeline result", risk: "low", files: [], findings: [] },
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
    durationMs: 12,
    base,
    head,
    mode: "full",
    unreviewed: [],
    specialists: [{ name: "review", status: "ok", steps: 1 }],
    sessions: ["ses_review_child"],
    stats: { files: 1, additions: 1, deletions: 1 },
    notes: [],
  }
  if (variant === "overflow") {
    const finding = {
      id: "overflow_blocker",
      path: "src/parser.ts",
      line: 2,
      side: "RIGHT" as const,
      source: "review" as const,
      severity: "blocking" as const,
      category: "bug" as const,
      title: "Overflow-only blocker",
      body: "An empty input reaches the unchecked parser and crashes.",
      confidence: 0.98,
    }
    outcome.report.findings.push(finding)
    outcome.selection.overflow.push(finding)
  }
  if (variant === "still-open")
    outcome.selection.stillOpen.push({
      id: "prior_blocker",
      where: "summary",
      path: "src/parser.ts",
      line: 2,
      side: "RIGHT",
      severity: "blocking",
      category: "bug",
      title: "Earlier blocker still open",
      sha: head,
      status: "open",
    })
  if (variant === "partial") {
    outcome.partial = "timeout"
    outcome.unreviewed = ["src/unreviewed.ts"]
    outcome.skipped = [{ path: "assets/image.png", reason: "binary" }]
    outcome.selection.dropped = [{ reason: "unconfirmed", count: 2 }]
  }
  const verdict = reviewVerdict({ kind: "outcome", outcome })
  const json = JSON.stringify({
    exitCode: verdict.verdict === "clean-complete" ? 0 : 1,
    target: {
      kind: input.target.kind === "staged" ? "staged" : "uncommitted",
      label: "local changes",
      baseRef: "HEAD",
      mergeBase: base,
      head,
    },
    outcome,
    verdict,
  })
  return {
    ...run(input, "completed"),
    completedAt: 2,
    artifact: {
      version: 1,
      json,
      bytes: Buffer.byteLength(json),
      sha256: createHash("sha256").update(json).digest("hex"),
    },
  }
}

async function engine(
  page: Page,
  options: {
    current?: ReviewRun.Info
    guest?: boolean
    failStart?: boolean
    targetUnavailable?: boolean
    movedHead?: boolean
  } = {},
) {
  const state = {
    current: options.current,
    starts: [] as ReviewRun.Start[],
    stops: [] as string[],
    reads: [] as string[],
    lost: options.failStart === true,
    targets: 0,
  }
  await page.route("**/fixture/**", async (route) => {
    const value = route.request(),
      path = new URL(value.url()).pathname.replace(/^\/fixture/, "")
    state.reads.push(`${value.method()} ${path}`)
    if (path === `/session/${parentID}`)
      return route.fulfill({ json: { id: parentID, projectID: "project", directory: "/repo" } })
    if (options.guest) return route.fulfill({ status: 403, json: { error: "Owner only" } })
    const root = `/experimental/session/${parentID}/review`
    if (path === `${root}/target`) {
      state.targets++
      if (options.targetUnavailable) return route.fulfill({ status: 400, json: { error: "Archived conversation" } })
      return route.fulfill({
        json: options.movedHead && state.targets > 1 ? { ...target, head: "c".repeat(40) } : target,
      })
    }
    if (path === root && value.method() === "GET") {
      const current = state.current
      const { artifact, ...summary } = current ?? {}
      return route.fulfill({ json: { runs: current ? [{ ...summary, hasResult: !!artifact }] : [] } })
    }
    if (path === root && value.method() === "POST") {
      const body: ReviewRun.Start = value.postDataJSON()
      state.starts.push(body)
      state.current = run(body)
      if (state.lost) {
        state.lost = false
        return route.abort("failed")
      }
      return route.fulfill({ json: state.current })
    }
    if (path === `${root}/${runID}/stop` && value.method() === "POST") {
      state.stops.push(runID)
      state.current = run(state.current?.request, "cancelled")
      return route.fulfill({ json: state.current })
    }
    if (path === `${root}/${runID}` && value.method() === "GET" && state.current)
      return route.fulfill({ json: state.current })
    return route.fulfill({ status: 404, json: { error: "Not found" } })
  })
  return state
}

const panel = (page: Page) => page.getByRole("region", { name: "Local VectorScope reviews" })
const open = (page: Page, suffix = "") => page.goto(`/e2e/fixtures/vectorscope-local.html${suffix}`)

test("local review needs no GitHub and starts only after the owner chooses exact staged scope and ceiling", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  const start = panel(page).getByRole("button", { name: "Start local review", exact: true })
  await expect(start).toBeEnabled()
  expect(state.starts).toEqual([])
  await page.getByLabel("Local review target").selectOption("staged")
  await page.getByLabel("Local review maximum cost").fill("0.25")
  await start.click()
  await expect(panel(page).getByRole("heading", { name: "Review running", exact: true })).toBeVisible()
  expect(state.starts).toHaveLength(1)
  expect(state.starts[0]).toEqual({ requestID: expect.any(String), target: { kind: "staged", head }, maxCost: 0.25 })
  await page.getByRole("button", { name: "Disable new reviews", exact: true }).click()
  await page.getByRole("button", { name: "Stop local review", exact: true }).click()
  await expect(panel(page).getByRole("heading", { name: "Review cancelled", exact: true })).toBeVisible()
  expect(state.stops).toEqual([runID])
  expect(state.reads.some((value) => /github|cloud-agents|model|prompt/.test(value))).toBe(false)
})

test("global default-off discovers existing results but performs no start", async ({ page }) => {
  const state = await engine(page, { current: await completed() })
  await open(page, "?enabled=0")
  await expect(panel(page).getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Open review", exact: true }).click()
  await expect(panel(page).getByText("Exact retained pipeline result", { exact: true })).toBeVisible()
  await expect(panel(page).getByText("clean-complete", { exact: true })).toBeVisible()
  expect(state.starts).toEqual([])
})

test("guest responses never establish owner permission or display retained code", async ({ page }) => {
  const state = await engine(page, { guest: true, current: await completed() })
  await open(page)
  await expect(panel(page).getByRole("alert")).toContainText("Owner access")
  await expect(panel(page).getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
  await expect(panel(page).getByText("Exact retained pipeline result", { exact: true })).toHaveCount(0)
  expect(state.starts).toEqual([])
})

test("closing and reopening after a lost Start response discovers the exact run without a second POST", async ({
  page,
}) => {
  const state = await engine(page, { failStart: true })
  await open(page)
  await expect(page.getByRole("button", { name: "Start local review", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Start local review", exact: true }).click()
  await expect(panel(page).getByRole("button", { name: "Retry exact request", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Close fixture panel", exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  expect(state.stops).toEqual([])
  await page.getByRole("button", { name: "Reopen fixture panel", exact: true }).click()
  await expect(panel(page).getByRole("heading", { name: "Review running", exact: true })).toBeVisible()
  expect(state.starts).toHaveLength(1)
  expect(state.current?.request).toEqual(state.starts[0])
})

test("owner retry sends the same request key and exact payload after a lost response", async ({ page }) => {
  const state = await engine(page, { failStart: true })
  await open(page)
  await expect(page.getByRole("button", { name: "Start local review", exact: true })).toBeEnabled()
  await page.getByLabel("Local review target").selectOption("staged")
  await page.getByRole("button", { name: "Start local review", exact: true }).click()
  await page.getByRole("button", { name: "Retry exact request", exact: true }).click()
  await expect(panel(page).getByRole("heading", { name: "Review running", exact: true })).toBeVisible()
  expect(state.starts).toHaveLength(2)
  expect(state.starts[1]).toEqual(state.starts[0])
})

test("a changed head refuses a fresh request before any model-start POST", async ({ page }) => {
  const state = await engine(page, { movedHead: true })
  await open(page)
  await expect(page.getByRole("button", { name: "Start local review", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Start local review", exact: true }).click()
  await expect(panel(page).getByRole("alert")).toContainText("Git head changed")
  expect(state.starts).toEqual([])
})

test("an archived target cannot start but the existing exact owned run can still be stopped", async ({ page }) => {
  const state = await engine(page, { current: run(), targetUnavailable: true })
  await open(page)
  await page.getByRole("button", { name: "Open review", exact: true }).click()
  await expect(page.getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Stop local review", exact: true }).click()
  await expect(panel(page).getByRole("heading", { name: "Review cancelled", exact: true })).toBeVisible()
  expect(state.stops).toEqual([runID])
  expect(state.starts).toEqual([])
})

test("a corrupted artifact is refused before a clean verdict or finding text reaches the panel", async ({ page }) => {
  const current = await completed()
  if (!current.artifact) throw new Error("Expected the actual retained artifact fixture")
  const state = await engine(page, {
    current: { ...current, artifact: { ...current.artifact, sha256: "0".repeat(64) } },
  })
  await open(page)
  await page.getByRole("button", { name: "Open review", exact: true }).click()
  await expect(panel(page).getByRole("alert")).toContainText("could not be verified")
  await expect(panel(page).getByText("Exact retained pipeline result", { exact: true })).toHaveCount(0)
  await expect(panel(page).getByText("clean-complete", { exact: true })).toHaveCount(0)
  expect(state.starts).toEqual([])
})

test("a foreign or unknown lease remains non-clean and never offers Stop or automatic recovery", async ({ page }) => {
  const state = await engine(page, {
    current: { ...run(), status: "unknown", canStop: false, error: "This engine does not own the review." },
  })
  await open(page)
  await page.getByRole("button", { name: "Open review", exact: true }).click()
  await expect(panel(page).getByRole("heading", { name: "Review unknown", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop local review", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Start local review", exact: true })).toBeDisabled()
  expect(state.starts).toEqual([])
  expect(state.stops).toEqual([])
})

for (const variant of ["overflow", "still-open"] as const)
  test(`a blocker retained only in ${variant} remains blocking and is actually visible`, async ({ page }) => {
    const state = await engine(page, { current: await completed(request, variant) })
    await open(page)
    await page.getByRole("button", { name: "Open review", exact: true }).click()
    const verdict = panel(page).getByRole("strong")
    await expect(verdict).toHaveText("blocking")
    await expect(verdict).toBeVisible()
    await expect(
      panel(page).getByText(variant === "overflow" ? "Overflow-only blocker" : "Earlier blocker still open", {
        exact: false,
      }),
    ).toBeVisible()
    await expect(panel(page).getByText("0 selected findings", { exact: false })).toHaveCount(0)
    if (variant === "overflow")
      await expect(panel(page).getByText("Showing 1 of 1 current findings.", { exact: true })).toBeVisible()
    else
      await expect(panel(page).getByText("Showing 1 of 1 earlier findings still open.", { exact: true })).toBeVisible()
    expect(state.starts).toEqual([])
  })

test("a partial review explains actual skipped, unreviewed and dropped coverage without implying a clean result", async ({
  page,
}) => {
  const state = await engine(page, { current: await completed(request, "partial") })
  await open(page)
  await page.getByRole("button", { name: "Open review", exact: true }).click()
  await expect(panel(page).getByText("incomplete", { exact: true })).toBeVisible()
  const coverage = panel(page).getByLabel("Local review coverage")
  await expect(coverage).toContainText("The review did not finish within its time limit.")
  await expect(coverage).toContainText("1 file was not reviewed")
  await expect(coverage).toContainText("src/unreviewed.ts")
  await expect(coverage).toContainText("assets/image.png · binary")
  await expect(coverage).toContainText("unconfirmed · 2")
  expect(state.starts).toEqual([])
})
