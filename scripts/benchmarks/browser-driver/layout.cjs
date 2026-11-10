"use strict"

// Serialized by Playwright into the page. This fixed reader accepts no caller code or selectors,
// reads top-level CSS-pixel geometry only, and never scrolls, focuses, resizes or changes the DOM.
function observeLayout() {
  const root = document.documentElement
  if (!root) return
  const layout = {
    viewportWidth: Math.round(window.innerWidth),
    viewportHeight: Math.round(window.innerHeight),
    documentWidth: Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0),
    documentHeight: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0),
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
  }
  if (
    !Object.values(layout).every((value) => Number.isFinite(value) && Math.abs(value) <= 100_000_000) ||
    layout.viewportWidth <= 0 ||
    layout.viewportHeight <= 0 ||
    layout.documentWidth <= 0 ||
    layout.documentHeight <= 0
  )
    return
  return layout
}

module.exports = { observeLayout }
