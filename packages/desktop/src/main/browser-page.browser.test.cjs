"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

// Run with Node 24+ and explicit PLAYWRIGHT_MODULE / CHROME_PATH. This owns a fresh
// headless browser; it never attaches to the user's browser or calls a model.
test(
  "serialized product observations preserve focus, mask passwords, and distinguish Tab leaving the document",
  {
    skip:
      !process.env.PLAYWRIGHT_MODULE || !process.env.CHROME_PATH
        ? "Set PLAYWRIGHT_MODULE and CHROME_PATH for the owned real-browser control."
        : false,
    timeout: 30_000,
  },
  async () => {
    const { observePage, readPage } = await import(pathToFileURL(path.join(__dirname, "browser-page.ts")).href)
    const { chromium } = require(path.resolve(process.env.PLAYWRIGHT_MODULE))
    const browser = await chromium.launch({
      executablePath: path.resolve(process.env.CHROME_PATH),
      headless: true,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
      env: Object.fromEntries(
        ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
    })
    try {
      const page = await browser.newPage()
      await page.route("**/*", (route) => route.abort("blockedbyclient"))
      await page.setContent(
        '<main><label>First <input type="text"></label><label>Password <input type="password" value="private-focus-fixture"></label><button>Last control</button></main>',
      )
      const observe = (maxElements = 50) =>
        page.evaluate(
          ({ source, maxElements }) => new Function("return (" + source + ")")()(window, { maxText: 100, maxElements }),
          { source: observePage.toString(), maxElements },
        )
      const focused = (snapshot, name) => {
        assert.equal(snapshot.focus.documentHasFocus, true)
        assert.equal(snapshot.focus.activeKind, "control")
        assert.equal(snapshot.focus.tabIndex, 0)
        assert.equal(snapshot.elements.find((item) => item.ref === snapshot.focus.focusedRef)?.name, name)
      }
      await page.getByRole("textbox", { name: "First", exact: true }).click()
      focused(await observe(), "First")
      focused(await observe(), "First")
      await page.getByRole("textbox", { name: "Password", exact: true }).click()
      const password = await observe()
      focused(password, "Password")
      assert.equal(password.focus.type, "password")
      assert.ok(!JSON.stringify(password).includes("private-focus-fixture"))
      const read = await page.evaluate(
        (source) => new Function("return (" + source + ")")()(window, { maxBytes: 1000 }),
        readPage.toString(),
      )
      assert.ok(!JSON.stringify(read).includes("private-focus-fixture"))
      focused(await observe(), "Password")
      assert.equal((await observe(1)).focus.focusedRef, undefined)
      await page.getByRole("button", { name: "Last control", exact: true }).click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.keyboard.press("Tab")
      const outside = await observe()
      assert.equal(outside.focus.documentHasFocus, false)
      assert.equal(outside.focus.activeKind, "body")
      assert.equal(outside.focus.focusedRef, undefined)
      assert.deepEqual((await observe()).focus, outside.focus)
      await page.keyboard.press("Tab")
      focused(await observe(), "First")
    } finally {
      await browser.close()
    }
  },
)
