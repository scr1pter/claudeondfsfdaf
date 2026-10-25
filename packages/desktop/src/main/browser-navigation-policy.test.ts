import { describe, expect, test } from "bun:test"
import {
  AUTOMATION_SETTLE_MS,
  DRIVING_COMMANDS,
  USER_NAVIGATION_WINDOW_MS,
  automationTurn,
  beginAutomation,
  browserOrigin,
  endAutomation,
  isAllowedBrowserNavigation,
  isLocalBrowserUrl,
  isUserNavigation,
  navigationIntent,
  recordPageInput,
} from "./browser-navigation-policy"

describe("browser navigation policy", () => {
  test("allows only loopback URLs without external-site approval", () => {
    expect(isLocalBrowserUrl("http://localhost:3000/path")).toBe(true)
    expect(isLocalBrowserUrl("https://app.localhost/test")).toBe(true)
    expect(isLocalBrowserUrl("http://127.0.0.1:4173")).toBe(true)
    expect(isLocalBrowserUrl("http://[::1]:8080")).toBe(true)
    expect(isLocalBrowserUrl("ftp://localhost/file")).toBe(false)
  })

  test("treats private-network hosts as external", () => {
    expect(isLocalBrowserUrl("http://10.0.0.2")).toBe(false)
    expect(isLocalBrowserUrl("http://172.16.0.2")).toBe(false)
    expect(isLocalBrowserUrl("http://192.168.1.2")).toBe(false)
  })

  test("keeps an approval scoped to its exact external origin", () => {
    const allowed = new Set(["https://example.com"])
    expect(isAllowedBrowserNavigation("https://example.com/docs", allowed)).toBe(true)
    expect(isAllowedBrowserNavigation("https://accounts.example.com/login", allowed)).toBe(false)
    expect(isAllowedBrowserNavigation("https://example.net", allowed)).toBe(false)
    expect(browserOrigin("javascript:alert(1)")).toBeUndefined()
  })
})

describe("who is driving the browser", () => {
  test("the user's own click lets the next navigation through", () => {
    const intent = navigationIntent()
    expect(isUserNavigation(intent, 1_000)).toBe(false)
    recordPageInput(intent, "mouseDown", 1_000)
    expect(isUserNavigation(intent, 1_200)).toBe(true)
    expect(isUserNavigation(intent, 1_000 + USER_NAVIGATION_WINDOW_MS)).toBe(false)
  })

  test("pointer movement and scrolling are not a choice to navigate", () => {
    const intent = navigationIntent()
    recordPageInput(intent, "mouseMove", 1_000)
    recordPageInput(intent, "mouseWheel", 1_000)
    recordPageInput(intent, undefined, 1_000)
    expect(isUserNavigation(intent, 1_100)).toBe(false)
  })

  test("input during and just after an automated command belongs to the automation", () => {
    const intent = navigationIntent()
    beginAutomation(intent)
    recordPageInput(intent, "keyDown", 1_000)
    expect(isUserNavigation(intent, 1_050)).toBe(false)
    endAutomation(intent, 1_100)
    recordPageInput(intent, "char", 1_100 + AUTOMATION_SETTLE_MS - 1)
    expect(isUserNavigation(intent, 1_100 + AUTOMATION_SETTLE_MS)).toBe(false)
    recordPageInput(intent, "mouseUp", 1_100 + AUTOMATION_SETTLE_MS)
    expect(isUserNavigation(intent, 1_200 + AUTOMATION_SETTLE_MS)).toBe(true)
  })

  test("an automated command never rides the user's earlier click", () => {
    const intent = navigationIntent()
    recordPageInput(intent, "mouseDown", 1_000)
    beginAutomation(intent)
    expect(isUserNavigation(intent, 1_100)).toBe(false)
    endAutomation(intent, 1_200)
    expect(isUserNavigation(intent, 1_300)).toBe(false)
  })

  test("overlapping commands keep the automation in charge until the last one ends", () => {
    const intent = navigationIntent()
    beginAutomation(intent)
    beginAutomation(intent)
    endAutomation(intent, 1_000)
    recordPageInput(intent, "mouseDown", 5_000)
    expect(isUserNavigation(intent, 5_100)).toBe(false)
    endAutomation(intent, 5_200)
    recordPageInput(intent, "mouseDown", 5_200 + AUTOMATION_SETTLE_MS)
    expect(isUserNavigation(intent, 5_300 + AUTOMATION_SETTLE_MS)).toBe(true)
  })

  test("every command that moves the page or puts input into it drives the browser, the new ones included", () => {
    for (const command of ["typeRef", "selectOption", "hover", "openTab", "openUrl", "click", "clickRef", "press"])
      expect({ command, driving: DRIVING_COMMANDS.has(command) }).toEqual({ command, driving: true })
    for (const command of ["listTabs", "switchTab", "closeTab", "readLogs", "observePage", "takeScreenshot"])
      expect({ command, driving: DRIVING_COMMANDS.has(command) }).toEqual({ command, driving: false })
  })

  test("a command given up at its deadline ends its hold once, so its late end leaves the next command's alone", () => {
    const intent = navigationIntent()
    const stuck = automationTurn(intent)
    stuck.begin()
    // The turn gives the stuck command up: the user's own clicks count again once the automation settles.
    stuck.end(1_000)
    recordPageInput(intent, "mouseDown", 1_000 + AUTOMATION_SETTLE_MS)
    expect(isUserNavigation(intent, 1_100 + AUTOMATION_SETTLE_MS)).toBe(true)
    const next = automationTurn(intent)
    next.begin()
    // The stuck command finishing late ends nothing more: the next command still holds the browser.
    stuck.end(5_000)
    recordPageInput(intent, "mouseDown", 6_000)
    expect(isUserNavigation(intent, 6_100)).toBe(false)
    next.end(7_000)
    expect(intent.driving).toBe(0)
  })
})
