import { expect, test, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"

const scope = `vrs1_${"1".repeat(64)}`
const proposed: ReviewMemoryControl.ProposedEntry = {
  id: "review_proposal",
  text: "PRIVATE_PROPOSED_OUTCOME",
  reason: "A retained review proposed this.",
  paths: ["src/*"],
  citations: [
    { path: "src/a.ts", line: 2, head: "a".repeat(40), quote: "<img src='/private-image' onerror='alert(1)'>" },
  ],
  visibility: "repository",
  kind: "outcome",
  origin: "review",
  status: "proposed",
  createdAt: 1,
  updatedAt: 2,
  source: { parentID: "ses_source_parent", reviewID: "ses_source_review", head: "a".repeat(40) },
}
const stored: ReviewMemoryControl.OwnerEntry = {
  id: "owner_preference",
  text: "PRIVATE_STORED_TEXT",
  reason: "Owner choice",
  paths: ["src/*"],
  citations: [],
  visibility: "private",
  kind: "preference",
  origin: "owner",
  status: "active",
  createdAt: 1,
  updatedAt: 2,
  approvedBy: "owner_local",
  approvedAt: 2,
}
const approved: ReviewMemoryControl.ApprovedEntry = {
  ...proposed,
  id: "approved_outcome",
  text: "PRIVATE_APPROVED_OUTCOME",
  reason: "PRIVATE_ORIGINAL_OUTCOME_REASON",
  status: "active",
  approvedBy: "owner_local",
  approvedAt: 2,
}
const reopeningReason = "PRIVATE_HUMAN_REOPEN_REASON: reconsider the empty-input case."
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
async function engine(page: Page, options: { enabled?: boolean; loseConfirm?: boolean; approved?: boolean } = {}) {
  const snapshot: ReviewMemoryControl.Inspect = {
    repository: "repo",
    scope,
    state: {
      enabled: options.enabled ?? true,
      generation: 0,
      entries: options.approved ? [stored, proposed, approved] : [stored, proposed],
    },
  }
  const state = {
    snapshot,
    reads: 0,
    requests: [] as string[],
    prepares: [] as ReviewMemoryControl.Prepare[],
    confirms: [] as ReviewMemoryControl.Confirmation[],
    previews: new Map<string, ReviewMemoryControl.Preview>(),
    used: new Set<string>(),
    lost: options.loseConfirm === true,
    holdRead: undefined as ReturnType<typeof pause> | undefined,
    holdPrepare: undefined as ReturnType<typeof pause> | undefined,
    holdConfirm: undefined as ReturnType<typeof pause> | undefined,
  }
  await page.route("**/fixture/review-memory**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace("/fixture/review-memory", "")
    state.requests.push(`${request.method()} ${path}`)
    if (path === "" && request.method() === "GET") {
      state.reads++
      const body: ReviewMemoryControl.Inspect =
        request.headers()["x-fixture-directory"] === "/other"
          ? {
              repository: "repo_other",
              scope: `vrs1_${"2".repeat(64)}`,
              state: { enabled: false, generation: 0, entries: [] },
            }
          : structuredClone(state.snapshot)
      const hold = state.holdRead
      state.holdRead = undefined
      if (hold) await hold.arrive()
      return route.fulfill({ json: body })
    }
    if (path === "/prepare") {
      const input = Schema.decodeUnknownSync(ReviewMemoryControl.Prepare)(request.postDataJSON())
      state.prepares.push(input)
      if (input.expectedScope !== state.snapshot.scope || input.command.expected !== state.snapshot.state.generation)
        return route.fulfill({ status: 400, json: { code: "stale" } })
      const command = input.command
      const { action, ...payload } = command
      const preview = Schema.decodeUnknownSync(ReviewMemoryControl.Preview)({
        previewId: randomUUID(),
        sha256: "3".repeat(64),
        expiresAt: Date.now() + ReviewMemoryControl.LIMIT.ttl,
        repository: state.snapshot.repository,
        scope: state.snapshot.scope,
        expected: input.command.expected,
        operation: action,
        payload:
          command.action === "approve" || command.action === "reopen"
            ? { ...payload, entry: state.snapshot.state.entries.find((entry) => entry.id === command.id) }
            : payload,
      })
      state.previews.set(preview.previewId, preview)
      const hold = state.holdPrepare
      state.holdPrepare = undefined
      if (hold) await hold.arrive()
      return route.fulfill({ json: preview })
    }
    if (path === "/confirm") {
      const input = Schema.decodeUnknownSync(ReviewMemoryControl.Confirmation)(request.postDataJSON())
      state.confirms.push(input)
      if (state.used.has(input.previewId)) return route.fulfill({ status: 400, json: { code: "used" } })
      const preview = state.previews.get(input.previewId)
      if (!preview) return route.fulfill({ status: 400, json: { code: "unavailable" } })
      if (preview.sha256 !== input.approvedSha256) return route.fulfill({ status: 400, json: { code: "stale" } })
      state.used.add(input.previewId)
      const next = { enabled: state.snapshot.state.enabled, generation: state.snapshot.state.generation + 1 }
      let result: ReviewMemoryControl.ConfirmationResult = next
      if (preview.operation === "configure") next.enabled = preview.payload.enabled
      if (preview.operation === "record") {
        const { expected, ...record } = preview.payload
        const entry: ReviewMemoryControl.OwnerEntry = {
          ...record,
          id: "new_preference",
          origin: "owner",
          status: "active",
          approvedAt: 2,
          approvedBy: "owner_local",
          createdAt: 1,
          updatedAt: 2,
        }
        state.snapshot = {
          ...state.snapshot,
          state: { ...state.snapshot.state, entries: [...state.snapshot.state.entries, entry] },
        }
        result = entry
      }
      if (preview.operation === "approve") {
        const entry: ReviewMemoryControl.ApprovedEntry = {
          ...preview.payload.entry,
          status: "active",
          approvedAt: 2,
          approvedBy: "owner_local",
        }
        state.snapshot = {
          ...state.snapshot,
          state: {
            ...state.snapshot.state,
            entries: state.snapshot.state.entries.map((value) => (value.id === entry.id ? entry : value)),
          },
        }
        result = entry
      }
      if (preview.operation === "reopen") {
        const original = preview.payload.entry
        const entry: ReviewMemoryControl.ProposedEntry = {
          id: original.id,
          kind: "outcome",
          origin: "review",
          status: "proposed",
          text: original.text,
          paths: original.paths,
          citations: original.citations,
          reason: preview.payload.reason,
          visibility: original.visibility,
          source: original.source,
          createdAt: original.createdAt,
          updatedAt: Date.now(),
        }
        state.snapshot = {
          ...state.snapshot,
          state: {
            ...state.snapshot.state,
            entries: state.snapshot.state.entries.map((value) => (value.id === original.id ? entry : value)),
          },
        }
        result = entry
      }
      if (preview.operation === "forget") {
        const id = preview.payload.id
        state.snapshot = {
          ...state.snapshot,
          state: { ...state.snapshot.state, entries: state.snapshot.state.entries.filter((entry) => entry.id !== id) },
        }
      }
      if (preview.operation === "erase")
        state.snapshot = { ...state.snapshot, state: { ...state.snapshot.state, entries: [] } }
      state.snapshot = { ...state.snapshot, state: { ...state.snapshot.state, ...next } }
      const hold = state.holdConfirm
      state.holdConfirm = undefined
      if (hold) await hold.arrive()
      if (state.lost) {
        state.lost = false
        return route.abort("failed")
      }
      return route.fulfill({ json: result })
    }
    if (path.startsWith("/previews/") && request.method() === "DELETE") {
      const id = path.slice("/previews/".length)
      state.used.add(id)
      return route.fulfill({ json: true })
    }
    return route.fulfill({ status: 404, json: { code: "not-found" } })
  })
  return state
}
const panel = (page: Page) => page.getByRole("region", { name: "Repository review memory", exact: true })
const open = (page: Page, query = "") => page.goto(`/e2e/fixtures/vectorscope-memory.html${query}`)
const approve = async (page: Page) => {
  const preview = panel(page).getByRole("region", { name: "Exact memory change preview" })
  await expect(preview.getByRole("button", { name: "Confirm this change", exact: true })).toBeDisabled()
  await preview.getByRole("checkbox", { name: "I reviewed this exact memory change", exact: true }).check()
  await preview.getByRole("button", { name: "Confirm this change", exact: true }).click()
}

test("reopening displays the complete original approval and a distinct human reason, then leaves the same row pending until another explicit approval", async ({
  page,
}) => {
  const state = await engine(page, { approved: true })
  await open(page)
  const entry = panel(page).getByRole("article", { name: `Memory entry ${approved.id}`, exact: true })
  await expect(panel(page).getByRole("button", { name: "Reopen approved outcome", exact: true })).toHaveCount(1)
  await expect(
    panel(page)
      .getByRole("article", { name: `Memory entry ${stored.id}`, exact: true })
      .getByRole("button", { name: "Reopen approved outcome", exact: true }),
  ).toHaveCount(0)
  await expect(
    panel(page)
      .getByRole("article", { name: `Memory entry ${proposed.id}`, exact: true })
      .getByRole("button", { name: "Reopen approved outcome", exact: true }),
  ).toHaveCount(0)
  await entry.getByRole("button", { name: "Reopen approved outcome", exact: true }).click()
  const reason = entry.getByRole("textbox", { name: "Reason to reopen outcome", exact: true })
  await expect(reason).toHaveValue("")
  await expect(entry.getByRole("button", { name: "Preview reopening outcome", exact: true })).toBeDisabled()
  await reason.fill(reopeningReason)
  expect(state.prepares).toHaveLength(0)
  await entry.getByRole("button", { name: "Preview reopening outcome", exact: true }).click()
  const preview = panel(page).getByRole("region", { name: "Exact memory change preview", exact: true })
  const original = preview.getByRole("region", { name: "Original approved outcome", exact: true })
  await expect(original).toContainText(approved.text)
  await expect(original).toContainText(approved.reason)
  await expect(original).toContainText(approved.source.parentID)
  await expect(original).toContainText(approved.source.reviewID)
  await expect(original).toContainText(approved.source.head)
  await expect(original).toContainText(approved.citations[0].quote)
  await original.getByText("Original approval details", { exact: true }).click()
  await expect(original).toContainText(approved.approvedBy)
  await expect(original).toContainText(`Created at: ${approved.createdAt}`)
  await expect(preview.getByRole("region", { name: "New human reason", exact: true })).toContainText(reopeningReason)
  await expect(panel(page).locator("img[src='/private-image']")).toHaveCount(0)
  expect(state.confirms).toHaveLength(0)
  await approve(page)
  await expect(entry).toContainText("Awaiting approval")
  await expect(entry.getByRole("button", { name: "Reopen approved outcome", exact: true })).toHaveCount(0)
  await expect(entry.getByRole("button", { name: "Preview approving outcome", exact: true })).toBeVisible()
  expect(state.prepares.map((input) => input.command.action)).toEqual(["reopen"])
  expect(state.snapshot.state.entries.find((value) => value.id === approved.id)).toMatchObject({
    id: approved.id,
    status: "proposed",
    reason: reopeningReason,
    source: approved.source,
    text: approved.text,
  })
  expect(state.snapshot.state.entries.find((value) => value.id === approved.id)).not.toHaveProperty("approvedBy")
  await entry.getByRole("button", { name: "Preview approving outcome", exact: true }).click()
  await approve(page)
  await expect(entry).toContainText("Approved")
  expect(state.prepares.map((input) => input.command.action)).toEqual(["reopen", "approve"])
  expect(state.snapshot.state.entries).toHaveLength(3)
})

test("unsubmitted reopening stays separate from the new-entry draft and survives a same-generation refresh with input focus", async ({
  page,
}) => {
  const state = await engine(page, { approved: true })
  await open(page)
  const ownerDraft = panel(page).getByRole("textbox", { name: "Memory entry text", exact: true })
  await ownerDraft.fill("PRIVATE_UNSUBMITTED_OWNER_DRAFT")
  const entry = panel(page).getByRole("article", { name: `Memory entry ${approved.id}`, exact: true })
  await entry.getByRole("button", { name: "Reopen approved outcome", exact: true }).click()
  const reason = entry.getByRole("textbox", { name: "Reason to reopen outcome", exact: true })
  await reason.fill(reopeningReason)
  await entry.getByRole("button", { name: "Cancel reopening", exact: true }).click()
  await expect(ownerDraft).toHaveValue("PRIVATE_UNSUBMITTED_OWNER_DRAFT")
  await entry.getByRole("button", { name: "Reopen approved outcome", exact: true }).click()
  await expect(reason).toHaveValue("")
  await reason.fill(reopeningReason)
  await reason.focus()
  const before = state.reads
  // Programmatic refresh does not move browser focus, as an unrelated owner GET would not.
  await panel(page)
    .getByRole("button", { name: "Refresh current memory", exact: true })
    .evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("Missing refresh button")
      button.click()
    })
  await expect.poll(() => state.reads).toBe(before + 1)
  await expect(entry.getByRole("button", { name: "Preview reopening outcome", exact: true })).toBeEnabled()
  await expect(reason).toHaveValue(reopeningReason)
  await expect(reason).toBeFocused()
  await expect(ownerDraft).toHaveValue("PRIVATE_UNSUBMITTED_OWNER_DRAFT")
  state.snapshot = { ...state.snapshot, state: { ...state.snapshot.state, generation: 1 } }
  await panel(page).getByRole("button", { name: "Refresh current memory", exact: true }).click()
  await expect(reason).toHaveCount(0)
  expect(state.prepares).toHaveLength(0)
  expect(state.confirms).toHaveLength(0)
})

test("lost reopen confirmation clears human text and only an explicit same-receipt retry follows the pending owner GET", async ({
  page,
}) => {
  const state = await engine(page, { approved: true, loseConfirm: true })
  await open(page)
  const entry = panel(page).getByRole("article", { name: `Memory entry ${approved.id}`, exact: true })
  await entry.getByRole("button", { name: "Reopen approved outcome", exact: true }).click()
  await entry.getByRole("textbox", { name: "Reason to reopen outcome", exact: true }).fill(reopeningReason)
  await entry.getByRole("button", { name: "Preview reopening outcome", exact: true }).click()
  await approve(page)
  await expect(panel(page).getByRole("region", { name: "Uncertain memory confirmation", exact: true })).toBeVisible()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  await panel(page).getByRole("button", { name: "Refresh current memory", exact: true }).click()
  await expect(entry).toContainText("Awaiting approval")
  expect(state.prepares).toHaveLength(1)
  expect(state.confirms).toHaveLength(1)
  await panel(page).getByRole("checkbox", { name: "Retry only the change I already approved", exact: true }).check()
  await panel(page).getByRole("button", { name: "Retry same confirmation", exact: true }).click()
  await expect(panel(page)).toContainText("already consumed")
  expect(state.confirms).toEqual([state.confirms[0], state.confirms[0]])
  expect(state.prepares).toHaveLength(1)
  expect(state.snapshot.state.generation).toBe(1)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("PRIVATE_")
})

test("owner retirement during delayed reopen preparation clears the human reason and cannot repaint its old preview", async ({
  page,
}) => {
  const state = await engine(page, { approved: true })
  await open(page)
  const entry = panel(page).getByRole("article", { name: `Memory entry ${approved.id}`, exact: true })
  await entry.getByRole("button", { name: "Reopen approved outcome", exact: true }).click()
  await entry.getByRole("textbox", { name: "Reason to reopen outcome", exact: true }).fill(reopeningReason)
  const hold = pause()
  state.holdPrepare = hold
  await entry.getByRole("button", { name: "Preview reopening outcome", exact: true }).click()
  await hold.entered
  await page.getByRole("button", { name: "Guest connection", exact: true }).click()
  hold.release()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  await expect(panel(page).getByRole("textbox", { name: "Reason to reopen outcome", exact: true })).toHaveCount(0)
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview", exact: true })).toHaveCount(0)
  expect(state.confirms).toHaveLength(0)
})

test("default-off memory needs explicit preview/consent, then owner preferences work without GitHub", async ({
  page,
}) => {
  const state = await engine(page, { enabled: false })
  await open(page)
  await expect(
    panel(page).getByText("Review memory is off. Stored entries are not used by reviews.", { exact: true }),
  ).toBeVisible()
  expect(state.prepares).toHaveLength(0)
  expect(state.confirms).toHaveLength(0)
  await panel(page).getByRole("button", { name: "Preview enabling memory", exact: true }).click()
  expect(state.confirms).toHaveLength(0)
  await approve(page)
  await expect(panel(page).getByRole("textbox", { name: "Memory entry text", exact: true })).toBeEnabled()
  await panel(page)
    .getByRole("textbox", { name: "Memory entry text", exact: true })
    .fill("Prefer explicit early returns.")
  await panel(page).getByRole("textbox", { name: "Memory entry reason", exact: true }).fill("Keep control flow clear.")
  await panel(page).getByRole("button", { name: "Preview new entry", exact: true }).click()
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview" })).toContainText(
    "Prefer explicit early returns.",
  )
  expect(state.confirms).toHaveLength(1)
  await approve(page)
  await expect(panel(page).getByRole("article", { name: "Memory entry new_preference", exact: true })).toContainText(
    "Prefer explicit early returns.",
  )
  expect(state.confirms).toHaveLength(2)
  expect(
    state.requests.every((value) => /^(GET|POST|DELETE) (|\/prepare|\/confirm|\/previews\/[^/]+)$/.test(value)),
  ).toBe(true)
})

test("proposed approval displays full provenance/quotes as text and never fetches embedded markup", async ({
  page,
}) => {
  const images: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("private-image")) images.push(request.url())
  })
  const state = await engine(page)
  await open(page)
  await panel(page).getByRole("button", { name: "Preview approving outcome", exact: true }).click()
  const preview = panel(page).getByRole("region", { name: "Exact memory change preview" })
  await expect(preview).toContainText("PRIVATE_PROPOSED_OUTCOME")
  await expect(preview).toContainText("ses_source_parent")
  await expect(preview).toContainText("ses_source_review")
  await expect(preview).toContainText(proposed.source.head)
  await expect(preview).toContainText(proposed.citations[0]!.quote)
  expect(images).toEqual([])
  expect(state.confirms).toHaveLength(0)
  await approve(page)
  await expect(panel(page).getByRole("article", { name: "Memory entry review_proposal", exact: true })).toContainText(
    "Review outcome · Approved",
  )
  expect(state.confirms).toHaveLength(1)
})

test("guest/capability refusal makes no requests; an owner-to-guest switch clears private draft, entries and approval", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page, "?owner=guest")
  await expect(panel(page)).toContainText("current engine owner")
  expect(state.requests).toEqual([])
  await page.getByRole("button", { name: "Fresh owner connection", exact: true }).click()
  await panel(page).getByRole("textbox", { name: "Memory entry text", exact: true }).fill("PRIVATE_DRAFT")
  await panel(page).getByRole("button", { name: "Preview approving outcome", exact: true }).click()
  await panel(page).getByRole("checkbox", { name: "I reviewed this exact memory change", exact: true }).check()
  await page.getByRole("button", { name: "Guest connection", exact: true }).click()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview" })).toHaveCount(0)
  expect(state.confirms).toHaveLength(0)
  await page.getByRole("button", { name: "Missing capability", exact: true }).click()
  expect(state.confirms).toHaveLength(0)
})

test("same-SDK authority retirement rejects a delayed old owner read until fresh proof", async ({ page }) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText("PRIVATE_STORED_TEXT")
  const hold = pause()
  state.holdRead = hold
  await panel(page).getByRole("button", { name: "Refresh current memory", exact: true }).click()
  await hold.entered
  await page.getByRole("button", { name: "Retire same SDK", exact: true }).click()
  hold.release()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  await expect(panel(page).getByRole("button", { name: "Refresh current memory", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Fresh owner connection", exact: true }).click()
  await expect(panel(page)).toContainText("PRIVATE_STORED_TEXT")
  expect(state.prepares).toHaveLength(0)
  expect(state.confirms).toHaveLength(0)
})

test("observed physical scope change clears old content and cannot retarget an in-progress preparation", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText("PRIVATE_STORED_TEXT")
  state.snapshot = {
    ...state.snapshot,
    scope: `vrs1_${"2".repeat(64)}`,
    state: { enabled: false, generation: 0, entries: [] },
  }
  await panel(page).getByRole("button", { name: "Preview disabling memory", exact: true }).click()
  await expect(panel(page)).toContainText("scope changed")
  await expect(panel(page)).not.toContainText("PRIVATE_")
  expect(state.prepares).toHaveLength(0)
  await panel(page).getByRole("button", { name: "Refresh current memory", exact: true }).click()
  await expect(panel(page)).toContainText("Review memory is off")
  expect(state.confirms).toHaveLength(0)
})

test("actual Solid store reconciliation cannot hide a fresh generation change or submit its captured stale command", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText("PRIVATE_STORED_TEXT")
  state.snapshot = { ...state.snapshot, state: { ...state.snapshot.state, generation: 1 } }
  await panel(page).getByRole("button", { name: "Preview disabling memory", exact: true }).click()
  await expect(panel(page)).toContainText("Review memory changed")
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview" })).toHaveCount(0)
  expect(state.prepares).toHaveLength(0)
  expect(state.confirms).toHaveLength(0)
})

test("generic selection changes and cold remount cannot turn a retired owner proof into a fresh one", async ({
  page,
}) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText("PRIVATE_STORED_TEXT")
  const reads = state.reads
  await page.getByRole("button", { name: "Retire same SDK", exact: true }).click()
  await page.getByRole("button", { name: "Navigate repository", exact: true }).click()
  await page.getByRole("button", { name: "Close fixture panel", exact: true }).click()
  await page.getByRole("button", { name: "Reopen fixture panel", exact: true }).click()
  await expect(panel(page).getByRole("button", { name: "Refresh current memory", exact: true })).toBeDisabled()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  expect(state.reads).toBe(reads)
  await page.getByRole("button", { name: "Fresh owner connection", exact: true }).click()
  await expect(panel(page)).toContainText("Selected local repository: /other")
  await expect(panel(page)).toContainText("Review memory is off")
  await expect(panel(page)).not.toContainText("PRIVATE_")
  expect(state.prepares).toHaveLength(0)
  expect(state.confirms).toHaveLength(0)
})

test("lost confirmation clears private text, refresh sends no action and explicit replay uses the identical approval once", async ({
  page,
}) => {
  const state = await engine(page, { loseConfirm: true })
  await open(page)
  await panel(page).getByRole("button", { name: "Preview disabling memory", exact: true }).click()
  await approve(page)
  await expect(panel(page).getByRole("region", { name: "Uncertain memory confirmation" })).toBeVisible()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  expect(state.snapshot.state.generation).toBe(1)
  await panel(page).getByRole("button", { name: "Refresh current memory", exact: true }).click()
  await expect(panel(page)).toContainText("does not prove")
  expect(state.prepares).toHaveLength(1)
  expect(state.confirms).toHaveLength(1)
  await expect(panel(page).getByRole("button", { name: "Preview enabling memory", exact: true })).toBeDisabled()
  const retry = panel(page).getByRole("button", { name: "Retry same confirmation", exact: true })
  await expect(retry).toBeDisabled()
  await panel(page).getByRole("checkbox", { name: "Retry only the change I already approved", exact: true }).check()
  await retry.click()
  await expect(panel(page)).toContainText("already consumed")
  expect(state.confirms).toEqual([state.confirms[0], state.confirms[0]])
  expect(state.prepares).toHaveLength(1)
  expect(state.snapshot.state.generation).toBe(1)
})

test("new service rejects an old approval without silently preparing or applying another one", async ({ page }) => {
  const state = await engine(page)
  await open(page)
  await panel(page).getByRole("button", { name: "Preview disabling memory", exact: true }).click()
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview" })).toBeVisible()
  state.previews.clear()
  await approve(page)
  await expect(panel(page)).toContainText("could not be verified")
  await expect(panel(page)).not.toContainText("PRIVATE_")
  expect(state.prepares).toHaveLength(1)
  expect(state.confirms).toHaveLength(1)
  expect(state.snapshot.state.generation).toBe(0)
})

test("idle expiry removes exact consent without any confirmation request", async ({ page }) => {
  const at = Date.now()
  await page.clock.install({ time: at })
  const state = await engine(page)
  await open(page)
  await panel(page).getByRole("button", { name: "Preview approving outcome", exact: true }).click()
  await panel(page).getByRole("checkbox", { name: "I reviewed this exact memory change", exact: true }).check()
  await page.clock.fastForward(ReviewMemoryControl.LIMIT.ttl + 1)
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview" })).toHaveCount(0)
  await expect(panel(page)).toContainText("approval expired")
  expect(state.confirms).toHaveLength(0)
})

test("navigation and close retire delayed preparation and leave no private text in local storage", async ({ page }) => {
  const state = await engine(page)
  await open(page)
  await expect(panel(page)).toContainText("PRIVATE_STORED_TEXT")
  const hold = pause()
  state.holdPrepare = hold
  await panel(page).getByRole("button", { name: "Preview approving outcome", exact: true }).click()
  await hold.entered
  await page.getByRole("button", { name: "Navigate repository", exact: true }).click()
  await page.getByRole("button", { name: "Close fixture panel", exact: true }).click()
  hold.release()
  await expect(panel(page)).toHaveCount(0)
  await page.getByRole("button", { name: "Reopen fixture panel", exact: true }).click()
  await expect(panel(page).getByRole("region", { name: "Exact memory change preview" })).toHaveCount(0)
  expect(state.confirms).toHaveLength(0)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("PRIVATE_")
})

test("an already sent confirmation cannot repaint a guest view when its old response returns", async ({ page }) => {
  const state = await engine(page)
  await open(page)
  await panel(page).getByRole("button", { name: "Preview disabling memory", exact: true }).click()
  const hold = pause()
  state.holdConfirm = hold
  await approve(page)
  await hold.entered
  await page.getByRole("button", { name: "Guest connection", exact: true }).click()
  hold.release()
  await expect(panel(page)).not.toContainText("PRIVATE_")
  await expect(panel(page)).toContainText("current engine owner")
  expect(state.confirms).toHaveLength(1)
  await expect(panel(page).getByRole("region", { name: "Uncertain memory confirmation" })).toHaveCount(0)
})
