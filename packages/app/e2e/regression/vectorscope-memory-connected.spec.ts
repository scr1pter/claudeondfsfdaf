import { expect, test, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"

const scope = `vrs1_${"1".repeat(64)}`
const otherScope = `vrs1_${"2".repeat(64)}`
const ownerEntry: ReviewMemoryControl.OwnerEntry = {
  id: "connected_owner_entry",
  kind: "preference",
  origin: "owner",
  status: "active",
  text: "PRIVATE_CONNECTED_MEMORY",
  reason: "An explicit stored owner preference.",
  paths: ["src/*"],
  citations: [],
  visibility: "private",
  approvedBy: "fixture-owner",
  approvedAt: 2,
  createdAt: 1,
  updatedAt: 2,
}
function pause() {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    arrive: () => {
      entered.resolve()
      return released.promise
    },
  }
}
async function engine(page: Page, mode: "owner" | "guest" | "html" | "malformed" = "owner") {
  const state = {
    requests: [] as { method: string; path: string; directory: string | null; body?: unknown }[],
    enabled: true,
    capability: true,
    generation: 0,
    allowed: false,
    previews: new Map<string, ReviewMemoryControl.Preview>(),
    used: new Set<string>(),
    holdConfig: undefined as ReturnType<typeof pause> | undefined,
    holdRead: undefined as ReturnType<typeof pause> | undefined,
  }
  await page.route("**/fixture/review-memory-connected/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/fixture\/review-memory-connected\/[^/]+/, "")
    const directory = url.searchParams.get("directory")
    state.requests.push({
      method: request.method(),
      path,
      directory,
      ...(request.method() === "POST" ? { body: request.postDataJSON() } : {}),
    })
    if (path === "/global/config") {
      const hold = state.holdConfig
      state.holdConfig = undefined
      if (hold) await hold.arrive()
      // Disabling new reviews must not hide owner data controls.
      return route.fulfill({
        json: { experimental: { vectorscope: state.enabled }, agent: { vectorscope: { disable: true } } },
      })
    }
    if (path === "/experimental/capabilities")
      return route.fulfill({
        json: { vectorscopeReviewMemoryControls: state.capability, vectorscopeRuns: false, vectorscopeSettings: false },
      })
    if (path === "/experimental/review-memory" && request.method() === "GET") {
      const second = url.pathname.startsWith("/fixture/review-memory-connected/second/")
      const body: ReviewMemoryControl.Inspect = {
        repository: directory === "/other" ? "other" : second ? "second" : "repo",
        scope: directory === "/other" || second ? otherScope : scope,
        state: {
          enabled: state.allowed,
          generation: state.generation,
          entries:
            directory === "/other" ? [] : [{ ...ownerEntry, text: second ? "PRIVATE_SECOND_MEMORY" : ownerEntry.text }],
        },
      }
      const hold = state.holdRead
      state.holdRead = undefined
      if (hold) await hold.arrive()
      if (mode === "guest") return route.fulfill({ status: 403, json: { message: "PRIVATE_UPSTREAM_DETAIL" } })
      if (mode === "html")
        return route.fulfill({ contentType: "text/html", body: "<html>PRIVATE_UPSTREAM_DETAIL</html>" })
      // A canceled request is expected when the real lifecycle component retires its captured SDK/directory.
      return route.fulfill({ json: mode === "malformed" ? { ...body, owner: true } : body }).catch(() => {})
    }
    if (path === "/experimental/review-memory/prepare") {
      const input = Schema.decodeUnknownSync(ReviewMemoryControl.Prepare)(request.postDataJSON())
      if (
        input.expectedScope !== scope ||
        input.command.expected !== state.generation ||
        input.command.action !== "configure"
      )
        return route.fulfill({ status: 400, json: { code: "stale", message: "Read the current state." } })
      const preview: ReviewMemoryControl.ConfigurePreview = {
        previewId: randomUUID(),
        sha256: "a".repeat(64),
        expiresAt: Date.now() + ReviewMemoryControl.LIMIT.ttl,
        repository: "repo",
        scope,
        expected: state.generation,
        operation: "configure",
        payload: { expected: state.generation, enabled: input.command.enabled },
      }
      state.previews.set(preview.previewId, preview)
      return route.fulfill({ json: preview })
    }
    if (path === "/experimental/review-memory/confirm") {
      const input = Schema.decodeUnknownSync(ReviewMemoryControl.Confirmation)(request.postDataJSON())
      if (state.used.has(input.previewId))
        return route.fulfill({ status: 400, json: { code: "used", message: "Already consumed." } })
      const preview = state.previews.get(input.previewId)
      if (!preview || preview.operation !== "configure" || preview.sha256 !== input.approvedSha256)
        return route.fulfill({ status: 400, json: { code: "stale", message: "Read the current state." } })
      state.used.add(input.previewId)
      state.generation++
      state.allowed = preview.payload.enabled
      return route.fulfill({ json: { enabled: state.allowed, generation: state.generation } })
    }
    return route.fulfill({ status: 404, json: { code: "unavailable", message: "Unavailable." } })
  })
  return state
}
const open = (page: Page, query = "") => page.goto(`/e2e/fixtures/vectorscope-memory-connected.html${query}`)
const panel = (page: Page) => page.getByRole("region", { name: "Repository review memory", exact: true })
const posts = (state: Awaited<ReturnType<typeof engine>>) =>
  state.requests.filter((request) => request.method === "POST")

for (const flag of ["optin", "capability", "health"])
  test(`connected memory with missing ${flag} sends zero generated SDK requests`, async ({ page }) => {
    const state = await engine(page)
    await open(page, `?${flag}=0`)
    await expect(page.getByRole("button", { name: "Verify owner access", exact: true })).toBeDisabled()
    await expect(panel(page)).toHaveCount(0)
    expect(state.requests).toEqual([])
  })

test("actual connected view requires its generated owner probe, keeps cleanup when reviews are disabled, and sends only the explicitly confirmed DTO", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText(ownerEntry.text)
  await expect(panel(page)).toContainText("Stored entries are not included in reviews yet.")
  expect(state.requests.slice(0, 3).map((request) => request.path)).toEqual([
    "/global/config",
    "/experimental/capabilities",
    "/experimental/review-memory",
  ])
  for (const request of state.requests.filter((request) => request.path.includes("review-memory")))
    expect(request.directory).toBe("/repo")
  expect(posts(state)).toEqual([])
  await panel(page).getByRole("button", { name: "Preview allowing review use", exact: true }).click()
  const preview = panel(page).getByRole("region", { name: "Exact memory change preview", exact: true })
  await expect(preview).toContainText("Allow approved entries from this repository in supported reviews.")
  await expect(preview.getByRole("button", { name: "Confirm this change", exact: true })).toBeDisabled()
  expect(posts(state)).toHaveLength(1)
  expect(posts(state)[0].body).toEqual({
    expectedScope: scope,
    command: { action: "configure", expected: 0, enabled: true },
  })
  await preview.getByRole("checkbox", { name: "I reviewed this exact memory change", exact: true }).check()
  await preview.getByRole("button", { name: "Confirm this change", exact: true }).click()
  await expect(panel(page)).toContainText("Use of approved entries in supported reviews is allowed.")
  expect(posts(state)).toHaveLength(2)
  const confirmed = posts(state)[1].body
  if (!confirmed || typeof confirmed !== "object") throw new Error("Missing actual SDK confirmation body")
  expect(Object.keys(confirmed).sort()).toEqual(["approvedSha256", "previewId"])
  expect(state.generation).toBe(1)
})

for (const mode of ["guest", "html", "malformed"] as const)
  test(`a ${mode} owner probe cannot mount private connected controls or send a write`, async ({ page }) => {
    const state = await engine(page, mode)
    await open(page)
    await expect(page.getByRole("region", { name: "Repository review-memory connection", exact: true })).toContainText(
      "could not be verified",
    )
    await expect(panel(page)).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText("PRIVATE_")
    expect(posts(state)).toEqual([])
  })

test("source changes during a held actual owner probe cannot grant the old directory", async ({ page }) => {
  const state = await engine(page)
  const hold = pause()
  state.holdRead = hold
  await open(page)
  await hold.entered
  await page.getByRole("button", { name: "Change directory", exact: true }).click()
  hold.release()
  await expect(panel(page)).toContainText("Selected local repository: /other")
  await expect(panel(page)).not.toContainText(ownerEntry.text)
  expect(posts(state)).toEqual([])
})

test("an edited connection cannot keep a same-SDK owner proof or send another request with its old authentication", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText(ownerEntry.text)
  const calls = state.requests.length
  await page.getByRole("button", { name: "Edit connection binding", exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("PRIVATE_")
  await expect(page.getByRole("button", { name: "Verify owner access", exact: true })).toBeDisabled()
  expect(state.requests).toHaveLength(calls)
  expect(posts(state)).toEqual([])
})

for (const button of ["Disable global opt-in", "Lose capability", "Lose health"])
  test(`observed ${button} retires existing private data before another generated request`, async ({ page }) => {
    const state = await engine(page)
    await open(page)
    await expect(panel(page)).toContainText(ownerEntry.text)
    const count = state.requests.length
    await page.getByRole("button", { name: button, exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText("PRIVATE_")
    await expect(page.getByRole("button", { name: "Verify owner access", exact: true })).toBeDisabled()
    expect(state.requests).toHaveLength(count)
  })

test("replacing the actual SDK during its owner probe grants only the replacement server after fresh verification", async ({
  page,
}) => {
  const state = await engine(page)
  const hold = pause()
  state.holdRead = hold
  await open(page)
  await hold.entered
  await page.getByRole("button", { name: "Replace SDK", exact: true }).click()
  await expect(panel(page)).toContainText("PRIVATE_SECOND_MEMORY")
  hold.release()
  await expect(panel(page)).not.toContainText(ownerEntry.text)
  expect(posts(state)).toEqual([])
})

test("same SDK reconnect retires private edits before verification and remount never reuses an owner proof", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText(ownerEntry.text)
  const allow = panel(page).getByRole("button", { name: "Preview allowing review use", exact: true })
  await allow.click()
  const preview = panel(page).getByRole("region", { name: "Exact memory change preview", exact: true })
  await preview.getByRole("checkbox", { name: "I reviewed this exact memory change", exact: true }).check()
  const hold = pause()
  state.holdConfig = hold
  await page.getByRole("button", { name: "Reconnect engine", exact: true }).click()
  await hold.entered
  await expect(panel(page)).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("PRIVATE_")
  hold.release()
  await expect(panel(page)).toContainText(ownerEntry.text)
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview", exact: true })).toHaveCount(0)
  expect(posts(state)).toHaveLength(1)
  const read = pause()
  state.holdRead = read
  await page.getByRole("button", { name: "Close connected panel", exact: true }).click()
  await page.getByRole("button", { name: "Open connected panel", exact: true }).click()
  await read.entered
  await expect(panel(page)).toHaveCount(0)
  read.release()
  await expect(panel(page)).toContainText(ownerEntry.text)
  expect(posts(state)).toHaveLength(1)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("PRIVATE_")
})
