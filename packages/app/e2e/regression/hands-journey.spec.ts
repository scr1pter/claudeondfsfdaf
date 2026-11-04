import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type {
  AssistantMessage,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  ToolPart,
  UserMessage,
} from "@vectordevai/sdk/v2"
import type { FakeComputerScript } from "../../src/features/computer/fake-platform"
import {
  toolPart,
  validateTimelineEvent,
  validateTimelineMessages,
  type TimelineMessage,
} from "../performance/timeline-stability/fixture"
import { calls, grantAlways, installFakeComputer, pushState } from "../utils/fake-computer"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

// The acceptance journey of section 1.5 (D12), against the fake platform and a scripted engine. The composer, docks,
// Tasks card, timeline and Settings are the real app. The engine's events are pushed on the page's event stream; the
// desktop's state is pushed through the fake, which records commands but never moves its own phase (D3.2), so each
// step pushes what desktop main would publish next. Banner, tray and overlay windows are not exercised (D12.4).

const directory = "C:/Vector/ComputerJourney"
const sessionID = "ses_computer_journey"
const title = "Computer journey fixture"
const projectID = "project-computer-journey"
// A fixed page clock keeps the composer's generated message IDs after the seeded history's.
const START = Date.UTC(2026, 9, 31, 10, 0, 0)
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
// A valid 1x1 PNG, inside the icon size limit.
const ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const numbers = { key: "app:macos:com.apple.iwork.numbers", name: "Numbers", running: true, icon: ICON }
const NUMBERS = { key: numbers.key, name: "Numbers" }
const granted: Computer.PermissionsView = {
  rows: [
    {
      id: "screen",
      status: "granted",
      pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    },
    {
      id: "accessibility",
      status: "granted",
      pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    },
  ],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
}
const ready: FakeComputerScript = { prefs: { enabled: true, consentedAt: 1 }, permissions: granted, apps: [numbers] }

/** The engine's ask for Numbers, raised by the computer call `partID` in its provider step `messageID`. */
function appAsk(id: string, messageID: string, partID: string): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "computer_app",
    patterns: [numbers.key],
    always: [numbers.key],
    tool: { messageID, callID: `call_${partID}` },
    metadata: {
      action: "use_app",
      level: "interact",
      target: {
        appName: "Numbers",
        appKey: numbers.key,
        platform: "macos",
        publisher: "Apple Inc.",
        verified: true,
        category: "office",
      },
      canAlways: true,
      mentioned: true,
    },
  }
}

test("first run: onboarding to Ready, a marked send, each ask, take-over and handoff, then Done", async ({ page }) => {
  const journey = await openJourney(page, { script: { prefs: { enabled: false }, recheck: granted, apps: [numbers] } })

  // 1. Onboarding on the macOS fake, entered from the @Hands row (1.5 A). It re-checks the grants every 2 s, so the
  // page clock holds until Check again has been seen to move them.
  await journey.composer.pressSequentially("@han")
  await expect(page.locator('[data-computer-row="feature"]')).toContainText("Off — set it up")
  await journey.beat()
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  await page.keyboard.press("Enter")
  const onboarding = page.locator('[data-component="computer-onboarding"]')
  await expect(onboarding).toBeVisible()
  await expect(journey.pills).toHaveCount(1)
  const turnOn = onboarding.getByRole("button", { name: `Turn on ${Hands.NAME}`, exact: true })
  await expect(turnOn).toBeEnabled()
  await turnOn.click()
  await expect.poll(() => calls(page)).toEqual([{ method: "setPrefs", prefs: { consentedAt: expect.any(Number) } }])
  const consent = (await calls(page))[0]
  const consentedAt = consent?.method === "setPrefs" ? consent.prefs.consentedAt : undefined
  expect(consentedAt).toBeGreaterThan(0)
  await expect(onboarding.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible()
  const rows = [
    onboarding.locator('[data-permission="screen"]'),
    onboarding.locator('[data-permission="accessibility"]'),
  ]
  for (const row of rows) await expect(row).toContainText("Not granted")
  const next = onboarding.getByRole("button", { name: "Continue", exact: true })
  await expect(next).toBeDisabled()
  await onboarding.getByRole("button", { name: "Check again", exact: true }).click()
  for (const row of rows) await expect(row).toContainText("Granted")
  await expect(next).toBeEnabled()
  await page.clock.resume()
  await next.click()
  await expect(onboarding.getByRole("heading", { name: "Try it", exact: true })).toBeVisible()
  // The composer path gives onboarding no example handler (D5b.7): the examples show, but none can replace the draft.
  for (const example of [
    `@${Hands.MENTION} put my October receipts into a Numbers table`,
    "@Excel copy the Q3 chart into my PowerPoint deck",
    `@${Hands.MENTION} open the app you just built in the iOS Simulator and tap through sign-up`,
  ])
    await expect(onboarding.getByRole("button", { name: example, exact: true })).toBeDisabled()
  await onboarding.getByRole("button", { name: "Finish", exact: true }).click()
  // Finish enables once and sends the same consent again (D6a.1).
  await expect
    .poll(() => calls(page))
    .toEqual([
      { method: "setPrefs", prefs: { consentedAt } },
      { method: "setPrefs", prefs: { enabled: true, consentedAt } },
    ])
  await expect(onboarding).toHaveCount(0)
  await expect(journey.pills).toHaveCount(1)
  // Desktop main moves its phase once Hands is on; the fake leaves that to the test (D12.4).
  await pushState(page, desk({ phase: "ready" }))
  const setup = await openSettings(page)
  await expect(statusPill(setup)).toHaveText("Ready")
  await expect(setup.locator('[data-section="always"]')).toContainText(
    "When you choose Always allow, the app appears here.",
  )
  await closeSettings(setup)
  await expect(journey.pills).toHaveCount(1)
  await journey.beat()

  // 2. "@Hands put my receipts in @Numbers": the POST carries exactly the documented markers (2.5).
  await journey.composer.focus()
  await page.keyboard.press("End")
  await journey.composer.pressSequentially(" put my receipts in ")
  await journey.composer.pressSequentially("@Num")
  await page.locator('[data-computer-row="app"]', { hasText: "@Numbers" }).click()
  await expect(journey.pills).toHaveCount(2)
  await page.keyboard.press("Enter")
  await expect.poll(() => journey.prompts.length).toBe(1)
  const prompt = journey.prompts[0]!
  expect(
    prompt.parts
      .filter((part) => part.metadata?.[Hands.MARKER])
      .map((part) => Object.fromEntries(Object.entries(part).filter(([key]) => key !== "id"))),
  ).toEqual([
    { type: "text", text: "", synthetic: true, metadata: { [Hands.MARKER]: { kind: "feature" } } },
    { type: "text", text: "", synthetic: true, metadata: { [Hands.MARKER]: { kind: "app", ...NUMBERS } } },
  ])
  expect(prompt.parts.some((part) => part.text?.includes("put my receipts in"))).toBe(true)
  await journey.accept(prompt)

  // 3. The first provider step looks at Numbers and the engine asks for it; Allow arms after 700 ms on the page
  // clock; Allow once is the only reply. Each step of the turn is its own assistant message, as the engine writes it.
  const look = await journey.step()
  const firstAsk = appAsk("perm_journey_app", look, "prt_journey_01")
  await pushState(page, holding(0, { phase: "asking", ask: askState(firstAsk.id, "app") }))
  const dock = await journey.ask(firstAsk)
  await expect(dock.getByRole("heading", { name: `Allow ${Hands.NAME} to use Numbers?`, exact: true })).toBeVisible()
  await expect(dock.getByText("You mentioned Numbers in your message.", { exact: true })).toBeVisible()
  const allow = dock.getByRole("button", { name: "Allow", exact: true })
  await journey.arm(699)
  await expect(allow).toBeDisabled()
  // A forced click bypasses Playwright's enabled wait, not the browser's disabled button.
  await allow.click({ force: true })
  expect(journey.replies).toEqual([])
  await journey.arm(700)
  await expect(allow).toBeEnabled()
  await allow.click()
  await expect
    .poll(() => journey.replies)
    .toEqual([{ path: `/permission/${firstAsk.id}/reply`, body: { reply: "once" } }])
  await page.clock.resume()
  await journey.replied(firstAsk.id, "once")
  await expect(dock).toHaveCount(0)

  // 4. Working: the composer's app, the Tasks card, and one run card that grows in place with its note (D8.2), across
  // the turn's step messages: the screenshot goes back to the model, which writes its note and two calls next.
  await pushState(page, holding(3, { step: "Typing in Numbers" }))
  await journey.part(
    computer("prt_journey_01", look, { action: "screenshot" }, { action: "screenshot", app: NUMBERS }, true),
  )
  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  await card.evaluate((element) => element.setAttribute("data-probe", "journey"))
  const table = await journey.step()
  await journey.part(text("prt_journey_02", table, "I'll put the receipts in a new table."))
  await journey.part(computer("prt_journey_03", table, { action: "click" }, clicked("New Table")))
  await journey.part(
    computer(
      "prt_journey_04",
      table,
      { action: "type" },
      { action: "type", app: NUMBERS, text: { length: 16, preview: "October receipts" } },
    ),
  )
  await expect(card.locator('[data-slot="computer-run-last"]')).toHaveText("Typed “October receipts” in Numbers")
  await expect(card).toHaveAttribute(
    "data-timeline-part-ids",
    "prt_journey_01,prt_journey_02,prt_journey_03,prt_journey_04",
  )
  await expect(page.locator('[data-component="computer-run"][data-probe="journey"]')).toHaveCount(1)
  await expect(page.locator('[data-component="text-part"][data-timeline-part-id="prt_journey_02"]')).toHaveCount(0)
  await expect(journey.workingLine).toContainText("Using Numbers")
  await tasks(journey, true)
  await expect(journey.card).toContainText("Working")
  await expect(journey.card).toContainText("Typing in Numbers")
  await expect(journey.card).toContainText("3 actions")
  await expect(journey.dot).toBeVisible()
  await tasks(journey, false)

  // 5. A sensitive "Send": click-only, no Always, and Deny is the reply. A failed call ends the computer's work in its
  // step: any later call in the same message would not run (Computer.BATCH_FAILURE), so the model goes on in a new one.
  const send = await journey.step()
  const sensitiveAsk: PermissionRequest = {
    id: "perm_journey_sensitive",
    sessionID,
    permission: "computer_sensitive",
    patterns: ["window:42:7"],
    always: [numbers.key],
    metadata: { action: "click", why: "send", target: { appName: "Numbers", appKey: numbers.key }, targetName: "Send" },
    tool: { messageID: send, callID: "call_prt_journey_05" },
  }
  await pushState(page, holding(3, { phase: "asking", ask: askState(sensitiveAsk.id, "sensitive") }))
  const sensitive = await journey.ask(sensitiveAsk)
  await expect(
    sensitive.getByRole("heading", { name: `${Hands.NAME} wants to click “Send” in Numbers`, exact: true }),
  ).toBeVisible()
  await expect(sensitive.getByText("This sends a message.", { exact: true })).toBeVisible()
  await expect(sensitive.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0)
  const once = sensitive.getByRole("button", { name: "Allow once", exact: true })
  await journey.arm(700)
  await expect(once).toBeEnabled()
  await once.focus()
  await page.keyboard.press("Enter")
  await expect(sensitive).toBeVisible()
  expect(journey.replies).toHaveLength(1)
  await sensitive.getByRole("button", { name: "Deny", exact: true }).click()
  await expect.poll(() => journey.replies.length).toBe(2)
  expect(journey.replies[1]).toEqual({ path: `/permission/${sensitiveAsk.id}/reply`, body: { reply: "reject" } })
  await page.clock.resume()
  await journey.replied(sensitiveAsk.id, "reject")
  await expect(sensitive).toHaveCount(0)
  await journey.part(computer("prt_journey_05", send, { action: "click" }, { ...clicked("Send"), code: "denied" }))

  // 6. The user takes over with the mouse during the next step's click; Resume on the card hands the computer back.
  // The resumed call also ends its step's computer work, as a failed one does.
  const row = await journey.step()
  await pushState(page, holding(3, { phase: "paused", pause: "input", escStops: false }))
  await tasks(journey, true)
  await expect(journey.card).toContainText("Paused — you have control")
  await expect(journey.card.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0)
  await journey.card.getByRole("button", { name: "Resume", exact: true }).click()
  await expect.poll(async () => (await calls(page)).at(-1)).toEqual({ method: "command", command: "resume" })
  await pushState(page, holding(3))
  await expect(journey.card).toContainText("Working")
  await tasks(journey, false)
  await journey.part(
    computer(
      "prt_journey_06",
      row,
      { action: "click" },
      { ...clicked("Add Row"), paused: { by: "input", ms: 80_000 } },
    ),
  )

  // 7. A handoff (E6b.6) in a step of its own: the card sends the user to the conversation, where Continue answers
  // the question. The model asked for the step in its own words; the engine records the reason `other` (D12.5).
  const yourTurn = await journey.step()
  const handoff: QuestionRequest = {
    id: "que_journey_handoff",
    sessionID,
    tool: { messageID: yourTurn, callID: "call_prt_journey_07" },
    metadata: { computer: { kind: "handoff", app: "Numbers", reason: "other" } },
    questions: [
      {
        header: Hands.NAME,
        question: "Your turn in Numbers: sign in. Press Continue when you're done.",
        options: [
          { label: "Continue", description: "I have finished this step." },
          { label: "Stop", description: "End this computer task." },
        ],
        custom: false,
      },
    ],
  }
  const handoffInput = { action: "handoff", reason: "sign in", app: "Numbers" }
  await journey.part({
    ...toolPart("prt_journey_07", "computer", "running", handoffInput),
    sessionID,
    messageID: yourTurn,
  })
  await pushState(page, holding(3, { phase: "handoff", ask: askState(handoff.id, "handoff") }))
  await tasks(journey, true)
  await expect(journey.card).toContainText("Needs you")
  await expect(journey.card.getByRole("button", { name: "Review in the conversation", exact: true })).toBeVisible()
  await expect(journey.card.getByRole("button", { name: /^Allow/ })).toHaveCount(0)
  await expect(journey.card.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0)
  await tasks(journey, false)
  await journey.question(handoff)
  const question = page.locator('[data-component="session-question-dock"]')
  await expect(question).toContainText("Your turn in Numbers: sign in. Press Continue when you're done.")
  await question.getByRole("radio", { name: /^Continue/ }).click()
  await question.getByRole("button", { name: "Submit", exact: true }).click()
  await expect
    .poll(() => journey.answers)
    .toEqual([{ path: `/question/${handoff.id}/reply`, body: { answers: [["Continue"]] } }])
  await journey.answered(handoff.id, [["Continue"]])
  await expect(question).toHaveCount(0)
  await pushState(page, holding(3))
  await journey.part(
    computer(
      "prt_journey_07",
      yourTurn,
      handoffInput,
      { action: "handoff", app: NUMBERS, handoff: { reason: "other" } },
      true,
    ),
  )

  // 8. Done. The card shows the desktop's count; the run card counts only what is known to have run (D8.9), so the
  // denied, paused and handed-off calls add nothing. ⌘S is one more step, and the answer the last.
  const save = await journey.step()
  await journey.part(
    computer("prt_journey_08", save, { action: "key" }, { action: "key", app: NUMBERS, keys: "cmd+s" }),
  )
  const answer = await journey.step()
  await journey.part(text("prt_journey_09", answer, "Your October receipts are in a new Numbers table."))
  // Until the turn ends, the answer after the last call stays in the live run (D8.2), from its own step message too.
  await expect(card).toHaveAttribute("data-timeline-part-ids", /,prt_journey_09$/)
  await journey.end({ finish: "stop" })
  await journey.status("idle")
  await pushState(page, holding(5, { phase: "done", escStops: false }))
  await tasks(journey, true)
  await expect(journey.card).toContainText("Done")
  await expect(journey.card).toContainText("5 actions")
  await expect(journey.card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(journey.dot).toHaveCount(0)
  await tasks(journey, false)
  await expect(card).toHaveCount(1)
  await expect(card).toHaveAttribute(
    "data-timeline-part-ids",
    [1, 2, 3, 4, 5, 6, 7, 8].map((index) => `prt_journey_0${index}`).join(","),
  )
  await expect(page.locator('[data-component="text-part"][data-timeline-part-id="prt_journey_09"]')).toBeVisible()
  const trigger = card.locator('[data-slot="computer-run-trigger"]')
  await expect(trigger).toContainText(`${Hands.NAME} · Numbers · 4 actions`)
  await trigger.click()
  await expect(labels(card)).toHaveText([
    "Looked at Numbers",
    "Clicked “New Table” in Numbers",
    "Typed “October receipts” in Numbers",
    "Clicked “Send” in Numbers",
    "Clicked “Add Row” in Numbers",
    "You took over (1m 20s)",
    "Resumed",
    "Your turn in Numbers: finish this step yourself",
    "Resumed",
    "Pressed ⌘S",
  ])
  await expect(card.locator('[data-slot="computer-run-step-status"]')).toHaveText(["Failed", "May not have run"])
  await expect(card).toContainText("The agent: I'll put the receipts in a new table.")
  // The model's own words for the handoff stay in the question; the card shows Vector's label only (INV-T5).
  await expect(card).not.toContainText("sign in")

  // 9. Allow once saved nothing: Settings still lists no always-allowed app.
  const after = await openSettings(page)
  await expect(statusPill(after)).toHaveText("Ready")
  await expect(after.locator('[data-section="always"]')).toContainText(
    "When you choose Always allow, the app appears here.",
  )
  expect(await calls(page)).toEqual([
    { method: "setPrefs", prefs: { consentedAt } },
    { method: "setPrefs", prefs: { enabled: true, consentedAt } },
    { method: "command", command: "resume" },
  ])
  expect(journey.aborts).toEqual([])
})

test("second run: Always allow, Stop on the card, then Settings lists Numbers", async ({ page }) => {
  const journey = await openJourney(page, { script: ready, messages: firstRun() })
  const card = page.locator('[data-component="computer-run"]').last()
  await expect(page.locator('[data-component="computer-run"]')).toHaveCount(1)

  await journey.composer.pressSequentially("@Num")
  await page.locator('[data-computer-row="app"]', { hasText: "@Numbers" }).click()
  await journey.composer.pressSequentially(" add a total row")
  await page.keyboard.press("Enter")
  await expect.poll(() => journey.prompts.length).toBe(1)
  const prompt = journey.prompts[0]!
  expect(prompt.parts.flatMap((part) => part.metadata?.[Hands.MARKER] ?? [])).toEqual([{ kind: "app", ...NUMBERS }])
  await journey.accept(prompt)

  // Always allow arms with Allow, and is the exact reply. Desktop main records it from the reply it observes
  // (D15, D16); the fixture stands in for that (D12.1).
  const click = await journey.step()
  const ask = appAsk("perm_journey_always", click, "prt_journey_11")
  await pushState(page, holding(0, { phase: "asking", ask: askState(ask.id, "app") }))
  const dock = await journey.ask(ask)
  const always = dock.getByRole("button", { name: "Always allow", exact: true })
  await journey.arm(699)
  await expect(always).toBeDisabled()
  await always.click({ force: true })
  expect(journey.replies).toEqual([])
  await journey.arm(700)
  await expect(always).toBeEnabled()
  await always.click()
  await expect.poll(() => journey.replies).toEqual([{ path: `/permission/${ask.id}/reply`, body: { reply: "always" } }])
  await page.clock.resume()
  await grantAlways(page, { key: numbers.key, name: "Numbers", publisher: "Apple Inc.", addedAt: START })
  await journey.replied(ask.id, "always")
  await expect(dock).toHaveCount(0)

  // Stop on the Tasks card goes to the desktop, which halts input first and aborts the turn itself (E6b.3, INV-R1):
  // the page sends no abort of its own. It lands in the next step, which types the total.
  await pushState(page, holding(1, { step: "Clicking “Add Row” in Numbers" }))
  await journey.part(computer("prt_journey_11", click, { action: "click" }, clicked("Add Row")))
  await expect(page.locator('[data-component="computer-run"]')).toHaveCount(2)
  await expect(card.locator('[data-slot="computer-run-last"]')).toHaveText("Clicked “Add Row” in Numbers")
  const typing = await journey.step()
  await tasks(journey, true)
  await journey.card.getByRole("button", { name: "Stop", exact: true }).click()
  await expect.poll(() => calls(page)).toEqual([{ method: "command", command: "stop" }])
  expect(journey.aborts).toEqual([])
  await pushState(page, holding(1, { phase: "stopped", escStops: false }))
  await expect(journey.card).toContainText("Stopped")
  await expect(journey.card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(journey.dot).toHaveCount(0)
  await tasks(journey, false)
  await journey.part(
    computer(
      "prt_journey_12",
      typing,
      { action: "type" },
      { action: "type", app: NUMBERS, text: { length: 11, preview: "=SUM(B2:B9)" }, code: "stopped" },
    ),
  )
  await journey.end({ error: { name: "MessageAbortedError", data: { message: "Aborted" } } })
  await journey.status("idle")
  await expect(card.locator('[data-slot="computer-run-last"]')).toHaveText("Stopped")
  const trigger = card.locator('[data-slot="computer-run-trigger"]')
  await expect(trigger).toContainText("Numbers · 1 action")
  await expect(card).toHaveAttribute("data-timeline-part-ids", "prt_journey_11,prt_journey_12")
  // The aborted step's interrupted marker follows the run card, which holds the completed step before it too.
  const divider = page.locator('[data-timeline-row="TurnDivider"]')
  await expect(divider).toContainText("Interrupted")
  const cardBox = await card.boundingBox()
  const dividerBox = await divider.boundingBox()
  expect(cardBox).not.toBeNull()
  expect(dividerBox).not.toBeNull()
  expect(dividerBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height - 1)
  // The stopped call may not have typed anything, so its text is never shown as typed (D8.9).
  await trigger.click()
  await expect(labels(card)).toHaveText(["Clicked “Add Row” in Numbers", "Typed text in Numbers", "Stopped"])
  await expect(card.locator('[data-slot="computer-run-step-status"]')).toHaveText(["May not have run"])
  await expect(card).not.toContainText("=SUM")

  const settings = await openSettings(page)
  await expect(statusPill(settings)).toHaveText("Ready")
  const listed = settings.locator(`[data-section="always"] [data-key="${numbers.key}"]`)
  await expect(listed).toContainText("Numbers")
  await expect(listed).toContainText("From Apple Inc.")
  await expect(listed.getByRole("button", { name: "Remove", exact: true })).toBeVisible()
  expect(await calls(page)).toEqual([{ method: "command", command: "stop" }])
  expect(journey.aborts).toEqual([])
})

test("screen-reader mode: a refused coordinate click is labeled by Vector, and read_ui refs carry on", async ({
  page,
}) => {
  const userID = "msg_0001_reader_a_user"
  // A model that cannot read images gets no screenshot; the engine refuses a coordinate click before it resolves the
  // app (E6b.7), so the refused part has no app. Each call needs the one before's result, so each is its own step.
  const steps = [
    (id: string) =>
      computer(
        "prt_reader_1",
        id,
        { action: "screenshot", app: "Numbers" },
        { action: "screenshot", app: NUMBERS, screenshot: false },
      ),
    (id: string) =>
      computer(
        "prt_reader_2",
        id,
        { action: "click", x: 412, y: 220 },
        { action: "click", code: "unsupported_action" },
        false,
        "This model cannot see screenshots; use read_ui refs",
      ),
    (id: string) =>
      computer("prt_reader_3", id, { action: "read_ui", app: "Numbers" }, { action: "read_ui", app: NUMBERS }),
    (id: string) => computer("prt_reader_4", id, { action: "click", ref: "e12" }, clicked("Save")),
    (id: string) => text("prt_reader_5", id, "I saved the receipts table."),
  ]
  await openJourney(page, {
    script: ready,
    image: false,
    messages: validateTimelineMessages([
      {
        info: user(userID, START - 60_000),
        parts: [
          {
            id: "prt_0001_reader_a_text",
            sessionID,
            messageID: userID,
            type: "text",
            text: `@${Hands.MENTION} save the table`,
          },
          marker("prt_0001_reader_a_hands", userID, { kind: "feature" }),
        ],
      },
      ...steps.map((part, index) => {
        const id = `msg_0001_reader_b_${index + 1}`
        const finish = index === steps.length - 1 ? "stop" : "tool-calls"
        return { info: assistant(id, userID, START - 59_000 + index * 1_000, { finish }), parts: [part(id)] }
      }),
    ]),
  })
  const card = page.locator('[data-component="computer-run"]')
  await expect(card).toHaveCount(1)
  const trigger = card.locator('[data-slot="computer-run-trigger"]')
  await expect(trigger).toContainText("Numbers · 3 actions")
  await trigger.click()
  await expect(labels(card)).toHaveText([
    "Looked at Numbers",
    "Clicked in the app",
    "Read controls in Numbers",
    "Clicked “Save” in Numbers",
  ])
  await expect(
    card.locator('[data-timeline-part-id="prt_reader_2"] [data-slot="computer-run-step-label"]'),
  ).toHaveAttribute("data-state", "failed")
  await expect(card.locator('[data-slot="computer-run-step-status"]')).toHaveText(["Failed"])
  // Vector-built labels only (INV-T5): the engine's refusal text never reaches the timeline.
  await expect(page.getByText("cannot see screenshots")).toHaveCount(0)
})

test("a dropped stream: the page re-reads the turn and its ask, and the ask is answered once", async ({ page }) => {
  const journey = await openJourney(page, { script: ready, messages: firstRun() })
  const runs = page.locator('[data-component="computer-run"]')
  await expect(runs).toHaveCount(1)
  const askID = "perm_journey_offline"

  // A new turn's prompt, its first step and the ask that step raised for Numbers reach only the server's reads: the
  // stream carrying them dies before the page reads them, and the watchdog replaces it (D12.4).
  const click = await journey.offline(async () => {
    await journey.accept({
      messageID: "msg_zy_journey_prompt",
      parts: [
        { id: "prt_zy_journey_1", type: "text", text: "@Numbers add a total row" },
        {
          id: "prt_zy_journey_2",
          type: "text",
          text: "",
          synthetic: true,
          metadata: { [Hands.MARKER]: { kind: "app", ...NUMBERS } },
        },
      ],
    })
    const step = await journey.step()
    await pushState(page, holding(0, { phase: "asking", ask: askState(askID, "app") }))
    await journey.asked(appAsk(askID, step, "prt_journey_21"))
    return step
  })
  await expect(
    page.locator('[data-timeline-row="UserMessage"][data-message-id="msg_zy_journey_prompt"]'),
  ).toContainText("add a total row")
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(dock.getByRole("heading", { name: `Allow ${Hands.NAME} to use Numbers?`, exact: true })).toBeVisible()

  // The re-read ask is the live one: Allow once is its only reply, and the turn goes on over the new stream.
  const allow = dock.getByRole("button", { name: "Allow", exact: true })
  await expect(allow).toBeEnabled()
  await allow.click()
  await expect.poll(() => journey.replies).toEqual([{ path: `/permission/${askID}/reply`, body: { reply: "once" } }])
  await journey.replied(askID, "once")
  await expect(dock).toHaveCount(0)
  await pushState(page, holding(1, { step: "Clicking “Add Row” in Numbers" }))
  // Only the re-read status says the turn is running: this page has had no status event since it opened.
  await expect(journey.workingLine).toContainText("Using Numbers")
  await journey.part(computer("prt_journey_21", click, { action: "click" }, clicked("Add Row")))
  await expect(runs).toHaveCount(2)
  await expect(runs.last()).toHaveAttribute("data-timeline-part-ids", "prt_journey_21")
  await expect(runs.last().locator('[data-slot="computer-run-last"]')).toHaveText("Clicked “Add Row” in Numbers")
  expect(journey.replies).toHaveLength(1)
})

test("the real layout leaves Hands asks and handoffs to main, and notifies once for check-ins and ordinary asks", async ({
  page,
}) => {
  // Record the browser platform's real notify() calls without opening owner OS notifications.
  await page.addInitScript(() => {
    const target = window as Window & { __computerNotifications?: { title: string; body: string }[] }
    target.__computerNotifications = []
    Object.defineProperty(document, "hasFocus", { value: () => false })
    Object.defineProperty(window, "Notification", {
      value: class {
        static permission = "granted"
        constructor(title: string, options?: NotificationOptions) {
          target.__computerNotifications!.push({ title, body: options?.body ?? "" })
        }
        close() {}
      },
    })
  })
  const journey = await openJourney(page, { script: ready, messages: firstRun() })
  const notifications = () =>
    page.evaluate(
      () =>
        (window as Window & { __computerNotifications?: { title: string; body: string }[] }).__computerNotifications ??
        [],
    )
  // Layout throttles every ask per conversation for five seconds, including those owned by desktop main.
  // Keep the stream live while moving the controlled clock between separate asks, so a throttle cannot hide
  // either a notification regression or the ordinary question/permission paths this case must observe.
  const advancePastAlertCooldown = async () => {
    await journey.beat()
    await page.clock.fastForward(5_001)
  }
  const app = appAsk("perm_notify_app", "msg_notify", "prt_notify")
  await journey.asked(app)
  await expect(page.locator('[data-component="dock-prompt"][data-kind="permission"]')).toBeVisible()
  expect(await notifications()).toEqual([])
  await journey.replied(app.id, "once")
  await expect(page.locator('[data-component="dock-prompt"][data-kind="permission"]')).toHaveCount(0)

  const handoff: QuestionRequest = {
    id: "que_notify_handoff",
    sessionID,
    metadata: { computer: { kind: "handoff", app: "Numbers", reason: "other" } },
    questions: [
      {
        header: Hands.NAME,
        question: "Finish this step",
        options: [{ label: "Continue", description: "Done" }],
        custom: false,
      },
    ],
  }
  await advancePastAlertCooldown()
  await journey.question(handoff)
  await expect(page.locator('[data-component="session-question-dock"]')).toBeVisible()
  expect(await notifications()).toEqual([])
  await journey.answered(handoff.id, [["Continue"]])
  await expect(page.locator('[data-component="session-question-dock"]')).toHaveCount(0)

  const checkIn: QuestionRequest = {
    ...handoff,
    id: "que_notify_check_in",
    metadata: { computer: { kind: "check_in", actions: 40, minutes: 5 } },
    questions: [
      {
        header: Hands.NAME,
        question: "Keep going?",
        options: [{ label: "Keep going", description: "Continue" }],
        custom: false,
      },
    ],
  }
  await advancePastAlertCooldown()
  await journey.question(checkIn)
  await expect(page.locator('[data-component="session-question-dock"]')).toContainText("Keep going?")
  await expect.poll(notifications).toHaveLength(1)
  await journey.answered(checkIn.id, [["Keep going"]])
  await expect(page.locator('[data-component="session-question-dock"]')).toHaveCount(0)

  await advancePastAlertCooldown()
  await journey.asked({
    ...app,
    id: "perm_notify_bash",
    permission: "bash",
    patterns: ["echo review"],
    always: ["echo review"],
    metadata: { command: "echo review" },
  })
  await expect.poll(notifications).toHaveLength(2)
  expect((await notifications()).map((item) => item.title)).toEqual(["Question", "Permission required"])
})

type Prompt = {
  messageID: string
  agent?: string
  parts: { id?: string; type: string; text?: string; synthetic?: boolean; metadata?: Record<string, unknown> }[]
}

/**
 * The session page with the fake desktop, a scripted engine on the page's event stream, and a server whose message,
 * permission, question and status reads follow the events. Every stream opens with `server.connected`, as the real
 * servers' streams do, so a stream the page replaces makes it re-read them, and a reload sees what the stream said.
 */
async function openJourney(
  page: Page,
  input: { script: FakeComputerScript; messages?: TimelineMessage[]; image?: boolean },
) {
  const prompts: Prompt[] = []
  const replies: { path: string; body: unknown }[] = []
  const answers: { path: string; body: unknown }[] = []
  const aborts: string[] = []
  const history = new Map<string, { info: Message; parts: Part[] }>(
    (input.messages ?? []).map((message) => [message.info.id, message]),
  )
  const statuses: Record<string, unknown> = {}
  // What the engine has asked and not yet been answered, for any re-read of the lists.
  const pending = { permissions: [] as PermissionRequest[], questions: [] as QuestionRequest[] }
  let events = 0
  await page.clock.install({ time: START })
  const transport = await installSseTransport<unknown>(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    path: "/global/event",
    retry: 20,
    connected: true,
  })
  await installFakeComputer(page, input.script, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "Computer journey" },
    provider: provider(input.image ?? true),
    sessions: [{ id: sessionID, title, directory, projectID, time: { created: START - 3_600_000, updated: START } }],
    pageMessages: (id) => ({
      items: id === sessionID ? [...history.values()].toSorted((a, b) => (a.info.id < b.info.id ? -1 : 1)) : [],
    }),
    capabilities: { backgroundSubagents: false, computer: { available: true, protocol: 1 } },
    permissions: () => pending.permissions,
    questions: () => pending.questions,
  })
  // Status re-reads follow the status events.
  await page.route(/\/session\/status(?:\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(statuses),
    }),
  )
  await page.route(/\/find\/file(?:\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
  })
  await page.route(/\/permission\/[^/]+\/reply(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    replies.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
  await page.route(/\/question\/[^/]+\/reply(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    answers.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
  await page.route(/\/session\/[^/]+\/abort(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    aborts.push(new URL(route.request().url()).pathname)
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
  }, directory)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  const composer = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
  await expect(composer).toBeVisible()
  await composer.focus()
  await expect(composer).toBeFocused()
  const launch = page.locator("[data-vector-bg-tasks-launch]").filter({ visible: true }).first()
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')

  const envelope = (type: string, properties: unknown) => ({
    directory,
    payload: { id: `evt_journey_${String(++events).padStart(4, "0")}`, type, properties },
  })
  // The page drops a stream that stays silent for 15 s on its own clock and opens another, and that can happen between
  // the check for an open stream and the write. A write that finds none throws before it enqueues anything, so only
  // that error is retried, on the next stream, and no event can arrive twice. An event the dropped stream had taken but
  // not yet handed to the page is lost with it; the next stream's `server.connected` makes the page re-read it.
  const write = async (send: () => Promise<unknown>): Promise<void> => {
    await expect
      .poll(async () => (await transport.connections()).some((connection) => connection.endedAt === undefined))
      .toBe(true)
    const sent = await send().then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && error.message.includes("SSE transport has no active connection")) return false
        throw error
      },
    )
    if (!sent) return write(send)
  }
  // Set while the engine works `offline` (below): the server's reads still follow, but no event reaches the page.
  let lost = false
  const deliver = (payload: unknown) => (lost ? Promise.resolve() : write(() => transport.send(payload)))
  // The engine's heartbeat. Sent before the page clock is held, so the stream cannot time out meanwhile.
  const beat = () => write(() => transport.heartbeat())
  const message = async (info: Message) => {
    history.set(info.id, { info, parts: history.get(info.id)?.parts ?? [] })
    await deliver(validateTimelineEvent(envelope("message.updated", { sessionID, info })))
  }
  const part = async (next: Part) => {
    const owner = history.get(next.messageID)
    if (!owner) throw new Error(`The journey sent part ${next.id} before its message ${next.messageID}`)
    owner.parts = [...owner.parts.filter((item) => item.id !== next.id), next].toSorted((a, b) =>
      a.id < b.id ? -1 : 1,
    )
    await deliver(validateTimelineEvent(envelope("message.part.updated", { sessionID, part: next, time: START })))
  }
  const status = async (type: "busy" | "idle") => {
    if (type === "busy") statuses[sessionID] = { type }
    if (type === "idle") delete statuses[sessionID]
    await deliver(validateTimelineEvent(envelope("session.status", { sessionID, status: { type } })))
  }
  /** The engine's ask; the server lists it until it is answered. */
  const asked = async (request: PermissionRequest) => {
    pending.permissions.push(request)
    await deliver(envelope("permission.asked", request))
  }
  // The live turn: the prompt it answers and its provider steps. The engine writes each step as a new assistant
  // message under the prompt (session/prompt.ts); the IDs sort after any message ID the composer generates.
  const turn = { parentID: "", steps: [] as string[] }
  const close = (outcome: Outcome) =>
    message(assistant(turn.steps.at(-1)!, turn.parentID, START + turn.steps.length * 1_000, outcome))
  let armAt: number | undefined

  return {
    composer,
    pills: composer.locator('[data-type="computer"]'),
    launch,
    dot: launch.locator("[data-computer-dot]"),
    pane: page.locator("#vector-bg-tasks"),
    card: page.locator('#vector-bg-tasks [data-computer-card="holder"]'),
    workingLine: page.locator('[data-component="session-composer-region"] [role="status"]'),
    prompts,
    replies,
    answers,
    aborts,
    part,
    status,
    beat,
    asked,
    /**
     * Engine work whose events never reach the page, as when the stream that carried them dies before the page reads
     * them: only the server's reads follow. The page's 15 s watchdog then replaces the stream, and the new one opens
     * with `server.connected`. Resolves with the work's result once the new stream is open (D12.4).
     */
    async offline<T>(work: () => Promise<T>) {
      const last = (await transport.connections()).at(-1)!
      lost = true
      const result = await work().finally(() => {
        lost = false
      })
      await page.clock.fastForward(15_000)
      await transport.waitForConnection({ after: last.id })
      return result
    },
    /** The engine removes an answered ask, as it does after the reply. */
    async replied(requestID: string, reply: "once" | "always" | "reject") {
      pending.permissions = pending.permissions.filter((item) => item.id !== requestID)
      await deliver(envelope("permission.replied", { sessionID, requestID, reply }))
    },
    async question(request: QuestionRequest) {
      pending.questions.push(request)
      await deliver(envelope("question.asked", request))
    },
    async answered(requestID: string, answers: string[][]) {
      pending.questions = pending.questions.filter((item) => item.id !== requestID)
      await deliver(envelope("question.replied", { sessionID, requestID, answers }))
    },
    /**
     * The engine's next provider step: it completes the step before, which ended on its tool calls, and opens a new
     * assistant message while the session stays busy. Returns the new message's ID.
     */
    async step() {
      if (turn.steps.length > 0) await close({ finish: "tool-calls" })
      // The app keeps messages in id order, as engine ids ascend, so the step number is zero-padded to keep a turn of
      // ten or more steps in order.
      const id = `msg_zz_journey_${String(turn.steps.length + 1).padStart(2, "0")}`
      turn.steps.push(id)
      await message(assistant(id, turn.parentID, START + turn.steps.length * 1_000))
      return id
    },
    /** The last step ends the turn: answered, or aborted as the desktop's Stop aborts it. */
    end: close,
    /** What the engine does with an accepted prompt: it stores the message under the posted ID and starts the turn. */
    async accept(prompt: Prompt) {
      turn.parentID = prompt.messageID
      await message(user(prompt.messageID, START, prompt.agent))
      for (const item of prompt.parts) {
        if (item.type !== "text" || !item.id || typeof item.text !== "string") continue
        await part({
          id: item.id,
          sessionID,
          messageID: prompt.messageID,
          type: "text",
          text: item.text,
          ...(item.synthetic === undefined ? {} : { synthetic: item.synthetic }),
          ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
        })
      }
      await status("busy")
    },
    /**
     * Raises an ask with the page clock held. Observe when its dock is inserted, then measure the 700 ms arm from
     * that instant. The SDK can flush up to 16 ms after its previous batch, so a zero-delay drain can leave the ask
     * queued forever. Advancing the queue must not count that delivery time toward the arm assertions.
     */
    async ask(request: PermissionRequest) {
      await beat()
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
      const shown = await page.evaluateHandle(() => {
        const state: { at?: number } = {}
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-component="dock-prompt"][data-kind="permission"]')) return
          state.at = Date.now()
          observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return { state, dispose: () => observer.disconnect() }
      })
      try {
        await asked(request)
        await expect
          .poll(async () => {
            await page.clock.runFor(16)
            return dock.isVisible()
          })
          .toBe(true)
        armAt = await shown.evaluate(({ state }) => state.at)
        expect(armAt).toBeDefined()
      } finally {
        await shown.evaluate(({ dispose }) => dispose())
        await shown.dispose()
      }
      return dock
    },
    /** Advance to an exact elapsed time from the current ask's observed appearance, not its network delivery. */
    async arm(ms: number) {
      if (armAt === undefined) throw new Error("The journey has not shown an ask")
      const remaining = armAt + ms - (await page.evaluate(() => Date.now()))
      expect(remaining).toBeGreaterThanOrEqual(0)
      await page.clock.runFor(remaining)
    },
  }
}

type Journey = Awaited<ReturnType<typeof openJourney>>

/** Opens or closes the Tasks pane. It can cover the docks, so it stays closed while they are answered. */
async function tasks(journey: Journey, open: boolean) {
  if ((await journey.pane.count()) > 0 !== open) await journey.launch.click()
  if (open) await expect(journey.card).toBeVisible()
  if (!open) await expect(journey.pane).toHaveCount(0)
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  await settings.getByRole("tab", { name: Hands.NAME, exact: true }).click()
  await expect(settings.getByRole("heading", { name: Hands.NAME, exact: true })).toBeVisible()
  return settings
}

async function closeSettings(settings: Locator) {
  await settings.getByRole("button", { name: "Back", exact: true }).click()
  await expect(settings).toHaveCount(0)
}

function statusPill(settings: Locator) {
  return settings.locator("[data-computer-status]").getByRole("status")
}

/** The step labels of an expanded run card, without the Failed or May not have run marker beside them. */
function labels(card: Locator) {
  return card.locator('[data-slot="computer-run-step-label"] > span:first-child')
}

function desk(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "ready",
    backend: "local-macos",
    mode: "foreground",
    apps: [],
    queue: [],
    escStops: false,
    stopChord: "⌘⇧Esc",
    lease: 0,
    reduceMotion: false,
    ...patch,
  }
}

/**
 * This conversation holding the computer, with Numbers last in its apps as desktop main keeps it (D18). `actions` is
 * the desktop's own count, which the Tasks card shows.
 */
function holding(actions: number, patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return desk({
    phase: "working",
    holder: { sessionID, directory, title, startedAt: START, actions },
    apps: [NUMBERS],
    escStops: true,
    lease: 1,
    ...patch,
  })
}

function askState(requestID: string, kind: "app" | "sensitive" | "handoff"): Computer.ComputerState["ask"] {
  const titles = {
    app: `Allow ${Hands.NAME} to use Numbers?`,
    sensitive: `${Hands.NAME} wants to click “Send” in Numbers`,
    handoff: "Your turn in Numbers",
  }
  return { requestID, directory, kind, title: titles[kind], canAlways: kind === "app", shownAt: START }
}

function clicked(target: string) {
  return { action: "click", app: NUMBERS, target: { role: "button", name: target } }
}

/** A completed computer call as the engine stores it: `metadata.truncated` and `action` are always written. */
function computer(
  id: string,
  messageID: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  shot = false,
  output = "Done.",
): ToolPart {
  return {
    ...toolPart(id, "computer", "completed", input, {
      output,
      title: Hands.NAME,
      metadata: { truncated: false, ...metadata },
      ...(shot
        ? {
            attachments: [
              { id: `${id}_shot`, sessionID, messageID, type: "file" as const, mime: "image/png", url: PNG },
            ],
          }
        : {}),
    }),
    sessionID,
    messageID,
  }
}

function text(id: string, messageID: string, value: string): Part {
  return { id, sessionID, messageID, type: "text", text: value }
}

function marker(id: string, messageID: string, value: Record<string, unknown>): Part {
  return { id, sessionID, messageID, type: "text", text: "", synthetic: true, metadata: { [Hands.MARKER]: value } }
}

function user(id: string, created: number, agent = "build"): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent,
    model: { providerID: "anthropic", modelID: "fixture/text" },
  }
}

/** How a provider step's message ends: with the provider's finish reason, or with the error an abort records. */
type Outcome = { finish: string } | { error: NonNullable<AssistantMessage["error"]> }

/** One provider step's assistant message; with an outcome it is complete, half a second after it started. */
function assistant(id: string, parentID: string, created: number, outcome?: Outcome): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created, ...(outcome ? { completed: created + 500 } : {}) },
    parentID,
    modelID: "fixture/text",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    ...outcome,
  }
}

/** An earlier Hands turn that chose Allow once, so the second run's ask is its first Always. */
function firstRun(): TimelineMessage[] {
  const userID = "msg_0000_journey_a_user"
  const lookID = "msg_0000_journey_b_1"
  const answerID = "msg_0000_journey_b_2"
  return validateTimelineMessages([
    {
      info: user(userID, START - 600_000),
      parts: [
        {
          id: "prt_0000_journey_a_text",
          sessionID,
          messageID: userID,
          type: "text",
          text: `@${Hands.MENTION} open my receipts`,
        },
        marker("prt_0000_journey_a_hands", userID, { kind: "feature" }),
      ],
    },
    {
      info: assistant(lookID, userID, START - 599_000, { finish: "tool-calls" }),
      parts: [
        computer(
          "prt_0000_journey_b_1",
          lookID,
          { action: "screenshot" },
          { action: "screenshot", app: NUMBERS },
          true,
        ),
      ],
    },
    {
      info: assistant(answerID, userID, START - 598_000, { finish: "stop" }),
      parts: [text("prt_0000_journey_b_2", answerID, "Your receipts are open in Numbers.")],
    },
  ])
}

function provider(image: boolean) {
  return {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        source: "api",
        models: {
          "fixture/text": {
            id: "fixture/text",
            name: "Fixture Text",
            providerID: "anthropic",
            limit: { context: 128000, output: 8000 },
            cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
            variants: {},
            capabilities: { toolcall: true, input: { text: true, image }, output: { text: true } },
            modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
            tool_call: true,
          },
        },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "fixture/text" },
  }
}
