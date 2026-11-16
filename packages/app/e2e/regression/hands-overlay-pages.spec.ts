import { expect, test, type Page } from "@playwright/test"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerOverlayPage } from "../../src/features/computer/overlay-page"

// The overlay pages desktop main loads into its glow, banner and cursor windows, rendered by Chromium from the same
// HTML strings. The test pushes the views main would send and records what the page asks main to do.

type Recorded = { acts: { action: string; requestID: string | null }[]; hovers: boolean[] }

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: { sessionID: "ses_overlay", directory: "/repo", title: "Receipts", startedAt: 1, actions: 3 },
    apps: [{ key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
    step: "Clicking “Save” in Numbers",
    queue: [],
    escStops: true,
    stopChord: Hands.STOP_CHORD.darwin,
    lease: 1,
    reduceMotion: false,
    ...patch,
  }
}

function ask(kind: Computer.AskKind, requestID: string) {
  return {
    requestID,
    directory: "/repo",
    kind,
    title: `Allow ${Hands.NAME} to use Numbers?`,
    canAlways: true,
    shownAt: 1,
  }
}

test.beforeEach(async ({ page }) => {
  await page.clock.install()
})

async function open(page: Page, html: string, viewport = { width: 640, height: 40 }) {
  await page.setViewportSize(viewport)
  await page.setContent(html)
  await page.evaluate(() => {
    const recorded: Recorded = { acts: [], hovers: [] }
    Object.assign(window, {
      recorded,
      computerOverlay: {
        onState: () => {},
        act: (action: string, requestID?: string) => {
          recorded.acts.push({ action, requestID: requestID ?? null })
          return Promise.resolve(true)
        },
        hover: (on: boolean) => recorded.hovers.push(on),
      },
    })
  })
}

async function push(page: Page, message: ComputerOverlayPage.OverlayMessage | undefined) {
  if (!message) throw new Error("no view for this state")
  await page.evaluate((data) => window.postMessage(data, "*"), message)
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as { recorded: Recorded }).recorded)

test("a label containing markup renders as text", async ({ page }) => {
  await open(page, ComputerOverlayPage.bannerPage())
  await push(page, ComputerOverlayPage.bannerView(state({ step: "Clicking “<b>Save</b>” in <img src=x>Numbers" })))
  const line = page.locator(".line")
  await expect(line).toHaveText("Clicking “<b>Save</b>” in <img src=x>Numbers")
  await expect(page.locator(".banner b, .banner img")).toHaveCount(0)
  await expect(page.locator(".title")).toHaveText(Hands.BANNER)
  await expect(page.getByRole("status")).toHaveText("Clicking “<b>Save</b>” in <img src=x>Numbers")
})

test("the buttons are focusable and labeled, and Stop always answers", async ({ page }) => {
  await open(page, ComputerOverlayPage.bannerPage())
  // Before the first state arrives, Stop is already there.
  await expect(page.getByRole("button")).toHaveText(["Stop"])
  await push(page, ComputerOverlayPage.bannerView(state()))
  await expect(page.getByRole("button")).toHaveText(["Take over", "Stop"])
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(async () => (await recorded(page)).acts).toEqual([{ action: "stop", requestID: null }])

  // Once an ask's answer is sent, its buttons wait for main; Stop does not.
  await push(page, ComputerOverlayPage.bannerView(state({ phase: "asking", ask: ask("app", "perm_deny") })))
  await page.getByRole("button", { name: "Deny", exact: true }).click()
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect
    .poll(async () => (await recorded(page)).acts)
    .toEqual([
      { action: "stop", requestID: null },
      { action: "deny", requestID: "perm_deny" },
      { action: "stop", requestID: null },
    ])

  // The clicks moved the real pointer onto the banner.
  await expect.poll(async () => (await recorded(page)).hovers[0]).toBe(true)
  await page.locator("html").dispatchEvent("pointerleave")
  await expect.poll(async () => (await recorded(page)).hovers.at(-1)).toBe(false)
})

test("Allow stays inert for 700 ms after the banner shows the ask, then answers once", async ({ page }) => {
  await open(page, ComputerOverlayPage.bannerPage())
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  await push(page, ComputerOverlayPage.bannerView(state({ phase: "asking", ask: ask("app", "perm_app") })))
  const allow = page.getByRole("button", { name: "Allow", exact: true })
  await expect(page.getByRole("button")).toHaveText(["Deny", "Allow", "Stop"])
  await expect(page.getByRole("button", { name: /always/i })).toHaveCount(0)
  await expect(allow).toBeDisabled()
  await page.clock.runFor(699)
  await allow.click({ force: true })
  expect((await recorded(page)).acts).toEqual([])
  await page.clock.runFor(1)
  await expect(allow).toBeEnabled()
  await allow.click()
  await allow.click({ force: true })
  await expect.poll(async () => (await recorded(page)).acts).toEqual([{ action: "allow", requestID: "perm_app" }])
  await expect(allow).toBeDisabled()
})

test("a sensitive ask answers mouse clicks only", async ({ page }) => {
  await open(page, ComputerOverlayPage.bannerPage())
  await push(page, ComputerOverlayPage.bannerView(state({ phase: "asking", ask: ask("sensitive", "perm_sensitive") })))
  const allow = page.getByRole("button", { name: "Allow once", exact: true })
  await expect(page.getByRole("button")).toHaveText(["Deny", "Allow once", "Stop"])
  await page.clock.runFor(700)
  await expect(allow).toBeEnabled()
  await allow.focus()
  await page.keyboard.press("Enter")
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Deny", exact: true }).focus()
  await page.keyboard.press("Enter")
  expect((await recorded(page)).acts).toEqual([])
  await allow.click()
  await expect.poll(async () => (await recorded(page)).acts).toEqual([{ action: "allow", requestID: "perm_sensitive" }])
})

test("the Esc keycap appears only for a foreground working state", async ({ page }) => {
  await open(page, ComputerOverlayPage.bannerPage())
  const key = page.locator(".key")
  await push(page, ComputerOverlayPage.bannerView(state()))
  await expect(key).toHaveText("Esc")
  await push(page, ComputerOverlayPage.bannerView(state({ mode: "background", escStops: false })))
  await expect(key).toHaveText("⌘⇧Esc")
  await push(page, ComputerOverlayPage.bannerView(state({ phase: "paused", pause: "input", escStops: false })))
  await expect(key).toHaveText("⌘⇧Esc")
  await push(
    page,
    ComputerOverlayPage.bannerView(
      state({ backend: "local-windows", stopChord: Hands.STOP_CHORD.win32, phase: "asking" }),
    ),
  )
  await expect(key).toHaveText("Ctrl+Alt+Shift+Esc")
  await push(page, ComputerOverlayPage.bannerView(state({ phase: "done" })))
  await expect(key).toBeHidden()
  await expect(page.locator(".title")).toBeHidden()
  await expect(page.locator(".line")).toHaveText("Done — your computer is yours again")
})

test("reduced motion stops the glow, and dim holds 38% either way", async ({ page }) => {
  const settled = () =>
    page.evaluate(() => ({
      running: document.getAnimations().filter((animation) => animation.playState === "running").length,
      glow: getComputedStyle(document.querySelector(".glow")!).opacity,
      breathe: getComputedStyle(document.querySelector(".breathe")!).opacity,
    }))
  await open(page, ComputerOverlayPage.glowStripPage("top"), { width: 800, height: 24 })
  await push(page, ComputerOverlayPage.glowView(state()))
  await expect(page.locator("html")).toHaveAttribute("data-variant", "working")
  expect((await settled()).running).toBeGreaterThan(0)

  await push(page, ComputerOverlayPage.glowView(state({ reduceMotion: true })))
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "")
  await expect.poll(settled).toEqual({ running: 0, glow: "1", breathe: "0.9" })

  await push(page, ComputerOverlayPage.glowView(state({ phase: "paused", reduceMotion: true })))
  await expect.poll(settled).toEqual({ running: 0, glow: "0.38", breathe: "1" })

  await page.emulateMedia({ reducedMotion: "reduce" })
  await open(page, ComputerOverlayPage.glowStripPage("left"), { width: 24, height: 600 })
  await push(page, ComputerOverlayPage.glowView(state()))
  await expect.poll(settled).toEqual({ running: 0, glow: "1", breathe: "0.9" })
  await push(page, ComputerOverlayPage.glowView(state({ phase: "handoff" })))
  await expect.poll(settled).toEqual({ running: 0, glow: "0.38", breathe: "1" })
  await push(page, ComputerOverlayPage.glowView(state({ mode: "background" })))
  await expect.poll(settled).toEqual({ running: 0, glow: "0.6", breathe: "0.9" })
})

test("a glow strip never takes the pointer", async ({ page }) => {
  await open(page, ComputerOverlayPage.glowStripPage("bottom"), { width: 800, height: 24 })
  await push(page, ComputerOverlayPage.glowView(state()))
  const hits = await page.evaluate(() => {
    const glow = document.querySelector(".glow")!
    return [
      [1, 1],
      [400, 12],
      [799, 23],
    ].map(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!)
      return hit !== null && glow.contains(hit)
    })
  })
  expect(hits).toEqual([false, false, false])
  const events = await page.evaluate(() =>
    [".glow", ".breathe", ".layer"].map(
      (selector) => getComputedStyle(document.querySelector(selector)!).pointerEvents,
    ),
  )
  expect(events).toEqual(["none", "none", "none"])
})

test("a 640 px banner screenshot is stable", async ({ page }) => {
  const queue = [{ sessionID: "ses_q", title: "Queued" }]
  for (const width of [640, 420]) {
    // Only the full-width banner has room for the key hint and the waiting chip.
    const full = width === 640
    await open(page, ComputerOverlayPage.bannerPage(), { width, height: 40 })
    await push(page, ComputerOverlayPage.bannerView(state({ queue })))
    const banner = page.locator(".banner")
    await expect(page.locator(".waiting")).toHaveText("+1 waiting")
    await expect(page.locator(".waiting")).toBeVisible({ visible: full })
    await expect(page.locator(".key")).toBeVisible({ visible: full })
    expect(await banner.boundingBox()).toEqual({ x: 0, y: 0, width, height: 40 })
    const first = await banner.screenshot({ animations: "disabled" })
    const second = await banner.screenshot({ animations: "disabled" })
    expect(first.equals(second)).toBe(true)

    // The fixed sentence sits above the step, and both rows keep a readable width, even beside the three buttons of a
    // sensitive ask at 420 px or the Windows chord and the waiting chip at 640 px. A long line is cut with an
    // ellipsis, and every button, Stop last, stays whole inside the banner.
    const long = "Clicking “Save” in Numbers ".repeat(20)
    const sensitive = (patch: Partial<Computer.ComputerState>) =>
      state({ phase: "asking", ask: { ...ask("sensitive", `perm_${width}`), title: long }, ...patch })
    for (const [view, labels, whole] of [
      [state({ step: long }), ["Take over", "Stop"], full],
      [sensitive({}), ["Deny", "Allow once", "Stop"], full],
      [
        sensitive({ backend: "local-windows", stopChord: Hands.STOP_CHORD.win32, queue }),
        ["Deny", "Allow once", "Stop"],
        false,
      ],
    ] as const) {
      await push(page, ComputerOverlayPage.bannerView(view))
      await expect(page.getByRole("button")).toHaveText([...labels])
      const [title, line] = await banner.evaluate((node) =>
        [".title", ".line"].map((selector) => {
          const row = node.querySelector<HTMLElement>(selector)!
          const rect = row.getBoundingClientRect()
          return {
            width: row.clientWidth,
            cut: row.scrollWidth > row.clientWidth,
            ellipsis: getComputedStyle(row).textOverflow,
            top: rect.top,
            bottom: rect.bottom,
          }
        }),
      )
      expect(title!.width).toBeGreaterThanOrEqual(100)
      expect(line!.width).toBeGreaterThanOrEqual(100)
      expect([title!.ellipsis, line!.ellipsis]).toEqual(["ellipsis", "ellipsis"])
      expect(line!.cut).toBe(true)
      if (whole) expect(title!.cut).toBe(false)
      expect(title!.top).toBeGreaterThanOrEqual(1)
      expect(title!.bottom).toBeLessThanOrEqual(line!.top)
      expect(line!.bottom).toBeLessThanOrEqual(39)
      const boxes = await page.getByRole("button").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right, clipped: node.scrollWidth > node.clientWidth }
        }),
      )
      for (const box of boxes)
        expect(box).toEqual({ left: expect.any(Number), right: expect.any(Number), clipped: false })
      expect(boxes[0]!.left).toBeGreaterThan(0)
      expect(boxes.at(-1)!.right).toBeLessThanOrEqual(width)
    }
  }
})

test("the cursor ring and ghost go where they are sent", async ({ page }) => {
  await open(page, ComputerOverlayPage.cursorPage(), { width: 800, height: 600 })
  // Hold the page clock so the ring cannot time out before it is measured.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  await push(page, { type: "cursor", kind: "ring", x: 120, y: 80, reduceMotion: false })
  const inner = page.locator(".ring i").first()
  await expect(inner).toBeVisible()
  const ring = await inner.boundingBox()
  expect(ring!.x + ring!.width / 2).toBe(120)
  expect(ring!.y + ring!.height / 2).toBe(80)
  await page.clock.runFor(700)
  await expect(inner).toBeHidden()

  const ghost = page.locator(".ghost")
  expect(await ghost.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0.24s")
  await push(page, { type: "cursor", kind: "ghost", x: 300, y: 200, reduceMotion: true })
  await expect(ghost).toBeVisible()
  await expect(page.locator(".tag")).toHaveText("Vector")
  expect(await ghost.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s")
  const box = await ghost.boundingBox()
  expect({ x: box!.x, y: box!.y }).toEqual({ x: 300, y: 200 })
  await push(page, { type: "cursor", kind: "hide", x: 0, y: 0, reduceMotion: true })
  await expect(ghost).toBeHidden()
  expect(await page.evaluate(() => document.elementFromPoint(305, 205)?.closest(".ghost") ?? null)).toBeNull()
})
