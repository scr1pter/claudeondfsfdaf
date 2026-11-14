import { expect, test } from "bun:test"
import { isComputerOverlay, registerComputerOverlay, shouldEmitWindowAllClosed } from "./computer-overlay-registry"

test("overlay identity is permanent and independent of URL", () => {
  const overlay = { url: "data:text/html,overlay", isVisible: () => true }
  registerComputerOverlay(overlay)
  overlay.url = "oc://renderer/index.html"
  expect(isComputerOverlay(overlay)).toBe(true)
  expect(isComputerOverlay({ ...overlay })).toBe(false)
})

test("overlays alone cannot keep the last main window open", () => {
  const overlay = { isVisible: () => true }
  registerComputerOverlay(overlay)
  const hiddenHost = { isVisible: () => false }
  const ordinary = { isVisible: () => true }
  expect(shouldEmitWindowAllClosed(0, [overlay])).toBe(true)
  expect(shouldEmitWindowAllClosed(0, [overlay, hiddenHost])).toBe(true)
  expect(shouldEmitWindowAllClosed(0, [overlay, ordinary])).toBe(false)
  expect(shouldEmitWindowAllClosed(1, [overlay])).toBe(false)
  // With no other native windows Electron emits its own event.
  expect(shouldEmitWindowAllClosed(0, [])).toBe(false)
})
