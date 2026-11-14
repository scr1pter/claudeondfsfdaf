import { expect, test } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/HiddenTerminalRegression"
const projectID = "proj_hidden_terminal_regression"
const sessionID = "ses_hidden_terminal_regression"
const title = "Hidden terminal regression"
const ptyID = "pty_hidden_terminal"

test("unmounts the terminal renderer while the pane is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockVectorServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "hidden-terminal-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["anthropic"],
      default: { providerID: "anthropic", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "hidden-terminal-regression",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // Directory-scoped SDK requests include a query string, so match exact paths. GET /pty lists the location's
  // terminals, as the server does: none until the spec's terminal is created, then that one.
  const terminal = { id: ptyID, title: "Terminal 1" }
  const listed: (typeof terminal)[] = []
  await page.route(
    (url) => ["/pty", `/pty/${ptyID}`, `/pty/${ptyID}/connect-token`].includes(url.pathname),
    (route) => {
      const url = new URL(route.request().url())
      const list = url.pathname === "/pty" && route.request().method() === "GET"
      expect(url.searchParams.get("directory")).toBe(directory)
      if (!list) expect(route.request().method()).toBe(url.pathname === `/pty/${ptyID}` ? "PUT" : "POST")
      if (url.pathname.endsWith("/connect-token")) expect(route.request().headers()["x-vector-ticket"]).toBe("1")
      if (url.pathname === "/pty" && !list && listed.length === 0) listed.push(terminal)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(
          list ? listed : url.pathname.endsWith("/connect-token") ? { ticket: "e2e-ticket" } : terminal,
        ),
      })
    },
  )
  const connections: string[] = []
  await page.routeWebSocket(
    (url) => url.pathname === `/pty/${ptyID}/connect`,
    (ws) => {
      const url = new URL(ws.url())
      expect(url.searchParams.get("directory")).toBe(directory)
      expect(url.searchParams.get("ticket")).toBe("e2e-ticket")
      connections.push(ws.url())
    },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.keyboard.press("Control+Backquote")
  const panel = page.locator("#terminal-panel")
  await expect(panel).toHaveAttribute("aria-hidden", "false")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()
  await expect.poll(() => connections.length).toBe(1)

  await page.keyboard.press("Control+Backquote")
  await expect(panel).toHaveAttribute("aria-hidden", "true")
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)

  await page.setViewportSize({ width: 1200, height: 700 })
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)

  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()
  await expect.poll(() => connections.length).toBe(2)
})

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
