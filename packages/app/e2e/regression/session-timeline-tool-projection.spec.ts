import { expect, test } from "@playwright/test"
import {
  assistantID,
  assistantMessage,
  partUpdated,
  reasoningPart,
  sessionID,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("renders every tool error outcome without leaking hidden tools", async ({ page }) => {
  const ordinary = ["bash", "edit", "write", "apply_patch", "webfetch", "websearch", "skill", "mcp_probe"]
  const parts = ordinary.map((tool, index) =>
    toolPart(`prt_error_${index}`, tool, "error", errorInput(tool), { error: `${tool} failed visibly` }),
  )
  parts.push(
    toolPart("prt_task_error", "task", "error", errorInput("task"), { error: "task failed visibly" }),
    toolPart("prt_question_dismissed", "question", "error", questionInput(), {
      error: "The user dismissed this question",
    }),
    toolPart("prt_question_error", "question", "error", questionInput(), { error: "Question transport failed" }),
    toolPart("prt_todo_error", "todowrite", "error", { todos: [] }, { error: "Hidden todo failure" }),
  )
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  await expect(page.locator('[data-kind="tool-error-card"]')).toHaveCount(ordinary.length + 1)
  await expect(page.getByText(/dismissed/i)).toBeVisible()
  await expect(page.locator('[data-timeline-part-id="prt_todo_error"]')).toHaveCount(0)
  for (let index = 0; index < ordinary.length; index++) {
    const row = page.locator(`[data-timeline-part-id="prt_error_${index}"]`)
    await expect(row).toBeVisible()
    await row.getByRole("button", { name: /Failed/ }).click()
    await expect(row.getByText(`${ordinary[index]} failed visibly`, { exact: true })).toBeVisible()
  }
  const question = page.locator('[data-timeline-part-id="prt_question_error"]')
  await question.getByRole("button", { name: /Failed/ }).click()
  await expect(question.getByText("Question transport failed", { exact: true })).toBeVisible()

  const task = page.locator('[data-timeline-part-id="prt_task_error"]')
  const chip = task.getByRole("button", { name: /Fail task.*1 failed.*Show in Background tasks/ })
  await expect(chip).toHaveAttribute("data-status", "failed")
  await chip.click()
  const detail = page.getByRole("button", { name: /Open Fail task.*Failed/ })
  await expect(detail).toBeVisible()
  await expect(detail).toHaveAttribute("title", /task failed visibly/)
})

test("transitions shell and question through running error outcomes", async ({ page }) => {
  const shellID = "prt_transition_error_shell"
  const questionID = "prt_transition_error_question"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(shellID, "bash", "pending", { command: "exit 1" }),
          toolPart(questionID, "question", "pending", questionInput()),
        ],
        { completed: false },
      ),
    ],
  })
  await timeline.waitForPart(shellID)
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  await timeline.send(partUpdated(toolPart(shellID, "bash", "running", { command: "exit 1" })), 120)
  await timeline.send(partUpdated(toolPart(questionID, "question", "running", questionInput())), 180)
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  await timeline.send(
    partUpdated(toolPart(shellID, "bash", "error", { command: "exit 1" }, { error: "Command exited 1" })),
    180,
  )
  await timeline.send(
    partUpdated(
      toolPart(questionID, "question", "error", questionInput(), { error: "The user dismissed this question" }),
    ),
    250,
  )

  await expect(page.locator(`[data-timeline-part-id="${shellID}"] [data-kind="tool-error-card"]`)).toBeVisible()
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toContainText(/dismissed/i)
})

// Sessions from earlier versions hold web search calls that named the search service they used; they all read as
// Web Search now.
test("labels web search calls from earlier versions without their search service", async ({ page }) => {
  const parts = [
    toolPart("prt_search_old", "websearch", "completed", { query: "older" }, { metadata: { provider: "exa" } }),
    toolPart("prt_search_generic", "websearch", "completed", { query: "generic" }),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  await expect(page.getByRole("button", { name: /^Web Search/ })).toHaveCount(2)
  await expect(page.getByRole("button", { name: /Exa/ })).toHaveCount(0)
})

// The app keeps a message's parts in id order, as engine ids ascend, so each Hands case numbers its part ids in the
// order the engine would write them.
const NUMBERS = { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }
const INTENT = "SENTINEL agent intent"
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const frame = { id: "frame_1", width: 200, height: 100, hash: "0123456789abcdef" }

test("a Hands run renders one card with Vector-built labels and the agent's words only under a step", async ({
  page,
}) => {
  const parts = [
    textPart("prt_run_01_lead", "I'll update the spreadsheet."),
    computer("prt_run_02", { action: "screenshot", frame }, { action: "screenshot" }, true),
    textPart("prt_run_03_note", "Saving the sheet now."),
    reasoningPart("prt_run_04_reason", "The Save button is in the toolbar."),
    computer(
      "prt_run_05",
      { action: "click", target: { role: "button", name: "Save" }, intent: INTENT },
      { action: "click", intent: INTENT },
    ),
    computer(
      "prt_run_06",
      { action: "type", text: { length: 16, preview: "October receipts" } },
      { action: "type", text: "October receipts" },
    ),
    computer("prt_run_07", { action: "key", keys: "cmd+s" }, { action: "key", keys: "cmd+s" }),
    computer("prt_run_08", { action: "scroll", screenshotRemoved: true }, { action: "scroll", direction: "down" }),
    textPart("prt_run_09_done", "Done."),
  ]
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage(parts)],
    settings: { showReasoningSummaries: true },
  })

  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  const trigger = card.locator('[data-slot="computer-run-trigger"]')
  await expect(trigger).toContainText("Numbers · 5 actions")
  await expect(trigger).not.toContainText(INTENT)
  // Collapsed: the newest screenshot-bearing step was pruned, and the last step is shown.
  await expect(card.getByText("Screenshot removed", { exact: true })).toBeVisible()
  await expect(card.locator('[data-slot="computer-run-last"]')).toHaveText("Scrolled down")
  // Text before and after the run keeps its own rows; the notes between steps are only in the card.
  await expect(page.locator('[data-component="text-part"][data-timeline-part-id="prt_run_01_lead"]')).toBeVisible()
  await expect(page.locator('[data-component="text-part"][data-timeline-part-id="prt_run_09_done"]')).toBeVisible()
  await expect(page.locator('[data-timeline-part-id="prt_run_03_note"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-part-id="prt_run_04_reason"]')).toHaveCount(0)

  await trigger.click()
  const steps = card.locator('[data-slot="computer-run-step-label"]')
  await expect(steps).toHaveText([
    "Looked at Numbers",
    "Clicked “Save” in Numbers",
    "Typed “October receipts” in Numbers",
    "Pressed ⌘S",
    "Scrolled down",
  ])
  await expect(card.locator('[data-slot="computer-run-note"]')).toHaveText([
    "The agent: Saving the sheet now.",
    "The agent: The Save button is in the toolbar.",
    `The agent: ${INTENT}`,
  ])
  await expect(card.locator('[data-timeline-part-id="prt_run_08"]')).toContainText("Screenshot removed")
})

test("a Hands thumbnail opens its preview, with the ring only where a single call clicked", async ({ page }) => {
  const parts = [
    computer(
      "prt_ring_01_click",
      { action: "click", target: { name: "Save" }, point: { x: 50, y: 25 }, frame },
      { action: "click", x: 50, y: 25 },
      true,
    ),
    // A batch rewrites the point for each group of steps, so its point inside the frame still draws no ring.
    computer(
      "prt_ring_02_batch",
      { action: "click", point: { x: 120, y: 60 }, frame },
      {
        action: "click",
        actions: [
          { action: "click", x: 120, y: 60 },
          { action: "key", keys: "cmd+s" },
        ],
      },
      true,
    ),
    // A paused click's screenshot is the frame after the user, and the click may never have run, so no ring.
    computer(
      "prt_ring_03_paused",
      { action: "click", point: { x: 50, y: 25 }, frame, paused: { by: "pointer", ms: 2_000 } },
      { action: "click", x: 50, y: 25 },
      true,
    ),
    // The engine records no point for a zoom, so its preview has no ring.
    computer("prt_ring_04_zoom", { action: "zoom", frame }, { action: "zoom" }, true),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  const card = page.locator('[data-component="computer-run"]')
  const preview = page.locator('[data-component="image-preview"]')
  await card.locator('[data-slot="computer-run-thumb"]').click()
  await expect(preview.locator('[data-slot="image-preview-image"]')).toBeVisible()
  await expect(preview.locator('[data-slot="computer-ring"]')).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(preview).toHaveCount(0)

  await card.locator('[data-slot="computer-run-trigger"]').click()
  // Each step of the batch has its own label.
  await expect(
    card.locator('[data-timeline-part-id="prt_ring_02_batch"] [data-slot="computer-run-step-label"]'),
  ).toHaveText(["Clicked in Numbers", "Pressed keys in Numbers"])
  for (const id of ["prt_ring_02_batch", "prt_ring_03_paused"]) {
    await card.locator(`[data-timeline-part-id="${id}"]`).getByRole("button", { name: "View screenshot" }).click()
    await expect(preview.locator('[data-slot="image-preview-image"]')).toBeVisible()
    await expect(preview.locator('[data-slot="computer-ring"]')).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(preview).toHaveCount(0)
  }

  await card
    .locator('[data-timeline-part-id="prt_ring_01_click"]')
    .getByRole("button", { name: "View screenshot" })
    .click()
  const ring = preview.locator('[data-slot="computer-ring"]')
  await expect(ring).toHaveAttribute("viewBox", "0 0 200 100")
  await expect(ring.locator("circle")).toHaveAttribute("cx", "50")
  await expect(ring.locator("circle")).toHaveAttribute("cy", "25")
})

test("a non-computer tool between Hands calls makes two cards", async ({ page }) => {
  const parts = [
    computer("prt_split_01", { action: "click" }, { action: "click" }),
    toolPart("prt_split_02_read", "read", "completed", { filePath: "src/app.ts" }),
    computer("prt_split_03", { action: "click" }, { action: "click" }),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  await expect(page.locator('[data-component="computer-run"]')).toHaveCount(2)
})

test("an interrupted Hands call is labeled by Vector, never by its raw error", async ({ page }) => {
  const parts = [
    computer("prt_abort_01", { action: "screenshot" }, { action: "screenshot" }),
    toolPart(
      "prt_abort_02",
      "computer",
      "error",
      { action: "open_app", app: INTENT },
      { error: "Tool execution aborted" },
    ),
  ]
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(parts, { error: { name: "MessageAbortedError", data: { message: "Aborted" } } }),
    ],
  })

  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  // Collapsed, the last step still says it failed, so the card never reads as if the app was opened.
  const last = card.locator('[data-slot="computer-run-last"]')
  await expect(last).toHaveAttribute("data-state", "failed")
  await expect(last).toContainText("Opened the app")
  await expect(last.locator('[data-slot="computer-run-step-status"]')).toHaveText("Failed")
  await card.locator('[data-slot="computer-run-trigger"]').click()
  await expect(card.locator('[data-timeline-part-id="prt_abort_02"]')).toContainText("Failed")
  await expect(card).not.toContainText("Tool execution aborted")
  await expect(card).not.toContainText(INTENT)
})

// A stop can come before the typing reached the app, and the engine records no executed count, so the card must not
// claim the text was typed. The note between the steps is only in the card, so the turn's footer stays on its own text.
test("a stopped Hands call never reads as done, and the turn keeps its footer", async ({ page }) => {
  const parts = [
    textPart("prt_stop_01_lead", "I'll send the reply."),
    computer("prt_stop_02", { action: "click", target: { name: "Reply" } }, { action: "click" }),
    textPart("prt_stop_03_note", "Typing the reply now."),
    computer(
      "prt_stop_04",
      { action: "type", text: { length: 18, preview: "Dear Bob, I resign" }, code: "stopped" },
      { action: "type" },
    ),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  await expect(card.locator('[data-slot="computer-run-trigger"]')).toContainText("Numbers · 1 action")
  await expect(card.locator('[data-slot="computer-run-last"]')).toHaveText("Stopped")
  await expect(page.locator('[data-slot="text-part-copy-wrapper"]')).toHaveCount(1)
  await expect(
    page.locator('[data-timeline-part-id="prt_stop_01_lead"] [data-slot="text-part-copy-wrapper"]'),
  ).toHaveCount(1)

  await card.locator('[data-slot="computer-run-trigger"]').click()
  const typed = card.locator('[data-timeline-part-id="prt_stop_04"] [data-slot="computer-run-step-label"]')
  await expect(typed).toHaveCount(2)
  await expect(typed.first()).toHaveAttribute("data-state", "unconfirmed")
  await expect(typed.first()).toContainText("Typed text in Numbers")
  await expect(typed.first().locator('[data-slot="computer-run-step-status"]')).toHaveText("May not have run")
  await expect(typed.last()).toHaveText("Stopped")
  await expect(card).not.toContainText("Dear Bob")
})

// Before run cards, the last note carried the turn's copy button, details and reply footer. When every text of the
// turn is a note inside the card, the card carries them instead.
test("a turn whose only text is a note in a Hands run keeps its footer under the card", async ({ page }) => {
  const parts = [
    computer("prt_held_01", { action: "screenshot" }, { action: "screenshot" }),
    textPart("prt_held_02_note", "Now I'll click Save."),
    toolPart("prt_held_03", "computer", "error", { action: "click" }, { error: "Tool execution aborted" }),
  ]
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(parts, { error: { name: "MessageAbortedError", data: { message: "Aborted" } } }),
    ],
  })

  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  await expect(page.locator('[data-component="text-part"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="text-part-copy-wrapper"]')).toHaveCount(1)
  const footer = card.locator('[data-slot="text-part-copy-wrapper"]')
  await expect(footer).toHaveCount(1)
  await expect(footer.getByRole("button", { name: "Copy response" })).toHaveCount(1)
  await expect(footer.locator('[data-slot="text-part-meta"]')).toContainText("Interrupted")
})

// A provider turn streams its narration before each call. The card must grow in place: the same element throughout,
// and no note mounted as its own row and then removed when the next call arrives.
test("a live Hands run grows in one card without adding and removing note rows", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([computer("prt_live_01", { action: "screenshot" }, { action: "screenshot" })], {
        completed: false,
      }),
    ],
  })
  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  await card.evaluate((element) => element.setAttribute("data-probe", "live"))
  await page.evaluate(() => {
    const rows: string[] = []
    Object.assign(window, { __noteRows: rows })
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          for (const row of [node, ...node.querySelectorAll('[data-component="text-part"]')])
            if (row.matches('[data-component="text-part"]')) rows.push(row.getAttribute("data-timeline-part-id") ?? "")
        }
    }).observe(document.body, { childList: true, subtree: true })
  })

  await timeline.send(partUpdated(textPart("prt_live_02_note", "Now clicking Save.")), 120)
  await timeline.send(partUpdated(toolPart("prt_live_03", "computer", "pending", { action: "click" })), 120)
  await timeline.send(partUpdated(toolPart("prt_live_03", "computer", "running", { action: "click" })), 120)
  await timeline.send(
    partUpdated(computer("prt_live_03", { action: "click", target: { name: "Save" } }, { action: "click" })),
    120,
  )
  await timeline.send(partUpdated(textPart("prt_live_04_note", "Typing the title.")), 120)
  await timeline.send(
    partUpdated(computer("prt_live_05", { action: "type", text: { length: 5, preview: "Hello" } }, { action: "type" })),
    120,
  )

  await expect(card.locator('[data-slot="computer-run-trigger"]')).toContainText("3 actions")
  await expect(page.locator('[data-component="computer-run"][data-probe="live"]')).toHaveCount(1)
  await expect(card).toHaveAttribute(
    "data-timeline-part-ids",
    "prt_live_01,prt_live_02_note,prt_live_03,prt_live_04_note,prt_live_05",
  )
  expect(await page.evaluate(() => (window as unknown as { __noteRows: string[] }).__noteRows)).toEqual([])
})

// A question renders nothing until it is answered, so it cannot end the run by following it. The agent's words
// before it must still show while it waits, not stay hidden in the collapsed card.
test("a question the turn waits on ends a live Hands run before the agent's words", async ({ page }) => {
  const parts = [
    computer("prt_ask_01", { action: "click", target: { name: "Save" } }, { action: "click" }),
    textPart("prt_ask_02_note", "The file already exists. I can overwrite it or save a copy."),
    toolPart("prt_ask_03_question", "question", "pending", questionInput()),
  ]
  await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts, { completed: false })] })

  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  await expect(card).toHaveAttribute("data-timeline-part-ids", "prt_ask_01")
  await expect(page.locator('[data-component="text-part"][data-timeline-part-id="prt_ask_02_note"]')).toBeVisible()
})

function computer(id: string, metadata: Record<string, unknown>, input: Record<string, unknown>, image = false) {
  return toolPart(id, "computer", "completed", input, {
    metadata: { app: NUMBERS, ...metadata },
    ...(image
      ? {
          attachments: [
            { id: `${id}_shot`, sessionID, messageID: assistantID, type: "file" as const, mime: "image/png", url: PNG },
          ],
        }
      : {}),
  })
}

function questionInput() {
  return { questions: [{ header: "Stability", question: "Keep it stable?", options: [] }] }
}

function errorInput(tool: string) {
  if (tool === "bash") return { command: "exit 1" }
  if (["edit", "write"].includes(tool)) return { filePath: "src/error.ts", content: "" }
  if (tool === "apply_patch") return { files: ["src/error.ts"] }
  if (tool === "webfetch") return { url: "https://example.com" }
  if (tool === "websearch") return { query: "failure" }
  if (tool === "task") return { description: "Fail task", subagent_type: "explore" }
  if (tool === "skill") return { name: "failure" }
  return { target: "failure" }
}
