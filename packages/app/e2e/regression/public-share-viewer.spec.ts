import { expect, test } from "@playwright/test"
import { Hands } from "@vectordevai/schema/hands"

const id = "a".repeat(32)
const api = `https://vectordev.ai/api/shares/${id}`
const snapshot = () => ({
  id,
  url: `https://vectordev.ai/s/${id}`,
  expiresAt: Date.now() + 86_400_000,
  updatedAt: Date.now(),
  revision: 1,
  updates: true,
  archive: {
    version: 1,
    engine: "v2",
    title: "Public viewer security fixture",
    messages: [
      {
        id: "z-first",
        role: "user",
        createdAt: 1,
        parts: [
          {
            type: "text",
            text: '# Visible Markdown\n\n<script>window.shareXss=1</script><img src="https://attacker.invalid/track" onerror="window.shareXss=2">\n\n[Unsafe](javascript:alert(1)) [Safe](https://example.com/ "quote & title")\n\n![Hidden tracker](https://attacker.invalid/pixel)\n\n```html\n<img src=x onerror=alert(1)>\n```',
          },
        ],
      },
      {
        id: "a-second",
        role: "assistant",
        createdAt: 2,
        parts: [
          { type: "reasoning", text: "Visible reasoning" },
          {
            type: "tool",
            name: "shell",
            callID: "call",
            status: "completed",
            input: "<iframe src=https://attacker.invalid>",
            output: "<svg/onload=alert(1)>",
          },
          { type: "attachment", name: "image.png", mediaType: "image/png" },
        ],
      },
    ],
  },
})

test("pruned production viewer renders ordered inert content and checks deletion", async ({ page }) => {
  const outside: string[] = []
  const sockets: string[] = []
  let removed = false
  let revision = 1
  await page.route(api, async (route) => {
    expect(route.request().headers().authorization).toBeUndefined()
    expect(route.request().headers().cookie).toBeUndefined()
    expect(route.request().headers().referer).toBeUndefined()
    if (removed) return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, json: {} })
    return route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        ...snapshot(),
        revision,
        archive: {
          ...snapshot().archive,
          title: revision === 1 ? "Public viewer security fixture" : "Updated visible title",
        },
      },
    })
  })
  page.on("request", (request) => {
    if (!request.url().startsWith(test.info().project.use.baseURL!) && request.url() !== api)
      outside.push(request.url())
  })
  page.on("websocket", (socket) => sockets.push(socket.url()))
  await page.goto(`/s/${id}`)
  await expect(page.getByRole("heading", { name: "Public viewer security fixture", exact: true })).toBeVisible()
  await expect(page.locator("article h2")).toHaveText(["user", "assistant"])
  await expect(page.locator("article img, article script, article iframe, article svg")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Unsafe", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Safe", exact: true })).toHaveAttribute("href", "https://example.com/")
  await expect(page.getByRole("link", { name: "Safe", exact: true })).toHaveAttribute(
    "rel",
    "noopener noreferrer nofollow",
  )
  await page.getByText("shell · completed", { exact: true }).click()
  await expect(page.getByText("<svg/onload=alert(1)>", { exact: true })).toBeVisible()
  await expect(page.getByText("Attachment: image.png (image/png) — description only", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Object.hasOwn(window, "shareXss"))).toBe(false)
  expect(outside).toEqual([])
  expect(sockets).toEqual([])
  await page.screenshot({ path: test.info().outputPath("public-viewer.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath("public-viewer-mobile.png"), fullPage: true })
  revision = 2
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.getByRole("heading", { name: "Updated visible title", exact: true })).toBeVisible()
  revision = 1
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.getByRole("heading", { name: "Updated visible title", exact: true })).toBeVisible()
  removed = true
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.getByRole("status")).toContainText("expired or is no longer shared")
  await expect(page.locator("article")).toHaveCount(0)
})

test("opted-in computer screenshots render as embedded images and fetch nothing", async ({ page }) => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
  const outside: string[] = []
  let revision = 1
  let updatedAt = Date.now()
  await page.route(api, (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        ...snapshot(),
        revision,
        updatedAt,
        archive: {
          ...snapshot().archive,
          messages: [
            ...snapshot().archive.messages,
            {
              id: "b-third",
              role: "assistant",
              createdAt: 3,
              parts: [
                {
                  type: "tool",
                  name: "computer",
                  callID: "computer-call",
                  status: "completed",
                  input: '{"action":"screenshot"}',
                  output: "Captured the screen",
                  // A live update never carries the one-time screenshot choice.
                  ...(revision === 1
                    ? { screenshots: [{ name: "screen.png", mediaType: "image/png", url: png }] }
                    : {}),
                },
              ],
            },
          ],
        },
      },
    }),
  )
  page.on("request", (request) => {
    const url = request.url()
    if (!url.startsWith(test.info().project.use.baseURL!) && url !== api && !url.startsWith("data:")) outside.push(url)
  })
  const notice = page.getByText(`The person who shared this chose to include screenshots from ${Hands.NAME}`)
  await page.goto(`/s/${id}`)
  await expect(page.getByRole("heading", { name: "Public viewer security fixture", exact: true })).toBeVisible()
  await expect(notice).toBeVisible()
  await page.getByText("computer · completed · 1 screenshot", { exact: true }).click()
  const image = page.getByRole("img", { name: `Screenshot 1 from ${Hands.NAME}`, exact: true })
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", png)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
  await page.getByText("shell · completed", { exact: true }).click()
  await expect(page.locator("article").nth(1).locator("img")).toHaveCount(0)
  await expect(page.locator("article img")).toHaveCount(1)
  expect(outside).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath("public-viewer-screenshots.png"), fullPage: true })
  // A check that finds the same revision updates the copy's details but keeps the transcript, so the opened step and
  // its image stay as they were.
  const step = page.locator("details.public-tool").filter({ has: image })
  await image.evaluate((element) => element.setAttribute("data-kept", ""))
  updatedAt = Date.UTC(2026, 0, 2, 3, 4, 5)
  const updated = await page.evaluate((value) => new Date(value).toLocaleString(), updatedAt)
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.locator(".public-meta")).toContainText(`Updated ${updated}`)
  await expect(step).toHaveJSProperty("open", true)
  await expect(image).toHaveAttribute("data-kept", "")
  await expect(image).toBeVisible()
  revision = 2
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(page.getByText("computer · completed", { exact: true })).toBeVisible()
  await expect(page.locator("article img")).toHaveCount(0)
  await expect(notice).toHaveCount(0)
  expect(outside).toEqual([])
})

test("expiry removes a snapshot even when subsequent requests fail", async ({ page }) => {
  let reads = 0
  await page.route(api, (route) => {
    reads++
    return reads === 1
      ? route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: { ...snapshot(), updates: false, expiresAt: Date.now() + 2000 },
        })
      : route.abort()
  })
  await page.goto(`/s/${id}`)
  await expect(page.getByRole("heading", { name: "Public viewer security fixture", exact: true })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("expired or is no longer shared", { timeout: 6000 })
  await expect(page.locator("article")).toHaveCount(0)
  expect(reads).toBe(1)
})

test("expiry wins over a delayed in-flight refresh", async ({ page }) => {
  let reads = 0
  let release: (() => void) | undefined
  await page.route(api, async (route) => {
    reads++
    if (reads === 1)
      return route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { ...snapshot(), expiresAt: Date.now() + 2000 },
      })
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route
      .fulfill({ headers: { "access-control-allow-origin": "*" }, json: { ...snapshot(), revision: 2 } })
      .catch(() => undefined)
  })
  await page.goto(`/s/${id}`)
  await expect(page.getByRole("heading", { name: "Public viewer security fixture", exact: true })).toBeVisible()
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect.poll(() => reads).toBe(2)
  await expect(page.getByRole("status")).toContainText("expired or is no longer shared", { timeout: 6000 })
  release?.()
  await expect(page.locator("article")).toHaveCount(0)
})

test("large content stays readable as inert text", async ({ page }) => {
  const text = `${"x".repeat(100_001)}<img src=https://attacker.invalid onerror=alert(1)>`
  await page.route(api, (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        ...snapshot(),
        archive: {
          version: 1,
          engine: "v1",
          title: "Large public transcript",
          messages: [{ id: "message", role: "user", createdAt: 1, parts: [{ type: "text", text }] }],
        },
      },
    }),
  )
  await page.goto(`/s/${id}`)
  await expect(page.locator("article pre")).toHaveText(text)
  await expect(page.locator("article img")).toHaveCount(0)
})
