import { afterEach, expect, test } from "bun:test"

// The session header's compact layout (1100 px wide and narrower) hides each tool's label span and keeps its count.
// The Tasks button's Hands dot is a span as well, and is the only sign on the button that Hands is active.
const css = (
  await Promise.all(
    ["../../vector-premium.css", "./background-tasks.css"].map((path) =>
      Bun.file(new URL(path, import.meta.url)).text(),
    ),
  )
).join("\n")

afterEach(() => {
  document.head.querySelector("style[data-computer-dot-test]")?.remove()
  document.body.replaceChildren()
})

test("the compact header keeps the Tasks button's Hands dot and count and hides its label", () => {
  // happy-dom's window is narrower than 1100 px, so the compact rules apply.
  expect(window.innerWidth).toBeLessThanOrEqual(1100)
  const style = document.createElement("style")
  style.dataset.computerDotTest = ""
  style.textContent = css
  document.head.append(style)
  document.body.innerHTML = `<button type="button" class="vector-bg-tasks-launch" data-vector-session-tool data-vector-bg-tasks-launch>
    <span id="label">Tasks</span>
    <span id="count" data-vector-session-count data-running="true">2</span>
    <span id="dot" class="vector-bg-tasks-computer-dot" data-computer-dot aria-hidden="true"></span>
  </button>`
  const display = (id: string) => getComputedStyle(document.getElementById(id)!).display
  expect(display("label")).toBe("none")
  expect(display("count")).not.toBe("none")
  expect(display("dot")).not.toBe("none")
})
