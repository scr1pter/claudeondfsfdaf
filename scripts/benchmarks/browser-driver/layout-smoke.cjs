"use strict"

// Real Chromium layout controls for the native product reader and the common driver reader.
// No model, external network, benchmark app, provider key or persistent profile is used.
const assert = require("node:assert/strict")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { observeLayout } = require("./layout.cjs")

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => args[args.indexOf(name) + 1]
  if (!args.includes("--playwright-module") || !args.includes("--chrome"))
    throw new Error("Use --playwright-module <package> --chrome <executable>.")
  const { chromium } = require(path.resolve(option("--playwright-module")))
  const { observePage } = await import(pathToFileURL(path.resolve(__dirname, "../../../packages/desktop/src/main/browser-page.ts")).href)
  const browser = await chromium.launch({ executablePath: path.resolve(option("--chrome")), headless: true })
  const checks = []
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" })
    await context.route("**/*", (route) => route.abort())
    const page = await context.newPage()
    for (const contained of [false, true]) {
      await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0}body{min-height:1400px}.wrapper{width:100%;${contained ? "overflow-x:auto" : ""}}table{width:548px;min-width:548px}td{height:40px}</style></head><body><button id="focused">Focus fixture</button><div class="wrapper"><table><tr><td>Wide table</td></tr></table></div></body></html>`)
      await page.locator("#focused").focus()
      await page.evaluate(() => window.scrollTo(0, 120))
      const before = await page.evaluate(() => ({ html: document.documentElement.outerHTML, x: scrollX, y: scrollY, focus: document.activeElement.id, width: innerWidth, height: innerHeight }))
      const common = await page.evaluate(observeLayout)
      const native = await page.evaluate("(" + observePage.toString() + ")(window, {maxText:100,maxElements:10})")
      assert.deepEqual(native.layout, common)
      assert.equal(common.viewportWidth, 390)
      assert.equal(common.viewportHeight, 844)
      assert.equal(common.documentWidth, contained ? 390 : 548)
      assert.equal(Math.max(0, common.documentWidth - common.viewportWidth), contained ? 0 : 158)
      assert.equal(common.scrollY, 120)
      assert.deepEqual(await page.evaluate(() => ({ html: document.documentElement.outerHTML, x: scrollX, y: scrollY, focus: document.activeElement.id, width: innerWidth, height: innerHeight })), before)
      assert.equal(await page.locator("table").evaluate((node) => node.getBoundingClientRect().width), 548)
      checks.push(contained ? "contained table has no document overflow; readers agree and leave DOM/focus/scroll unchanged" : "uncontained table exposes 158px document overflow at viewport390; readers agree and leave DOM/focus/scroll unchanged")
    }
    await context.close()
  } finally {
    await browser.close()
  }
  process.stdout.write(JSON.stringify({ checks, status: "passed" }) + "\n")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
